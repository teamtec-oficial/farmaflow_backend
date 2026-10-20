import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { getDatabaseStatus, getPrismaClient } from './prisma-client.js';
import { getStockAlertType } from './notification-utils.js';
import type { AuditLog, EPIItem, EPIStatus, EmailNotification, Movement, User } from '../frontend/src/types.js';
import type { AccessModule, AccessOperation, AccessPolicy } from '../frontend/src/lib/accessPolicy.js';
import { normalizeAccessPolicy } from '../frontend/src/lib/accessPolicy.js';
import { canAccess, getApiAccessRequirement, isApiRoutePublic } from './access-control.js';
import { hashPassword, isValidPassword, verifyPassword } from './password-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// CORS configuration for Vercel / cross-origin requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Initialize Prisma Client
const prisma = getPrismaClient();
const useDatabase = prisma !== null;

if (useDatabase) {
  console.log('🗄️  Modo: PostgreSQL via Prisma (Supabase) — dados persistidos no banco.');
} else {
  console.log('📦  Modo: In-Memory (banco não configurado) — dados voláteis (reiniciam com o servidor).');
}

// =================== STATE ===================
let passwordResetTokens: Record<string, { email: string; expires: number }> = {};

// =================== UTILITY FUNCTIONS ===================
function getEPIStatus(currentQty: number, minQty: number): EPIStatus {
  if (currentQty <= 0) return 'out_of_stock';
  if (currentQty <= minQty) return 'low';
  return 'normal';
}

// Map Prisma EPI status string to TypeScript EPIStatus
function mapDbStatusToEPIStatus(dbStatus: string): EPIStatus {
  if (dbStatus === 'esgotado') return 'out_of_stock';
  if (dbStatus === 'baixo') return 'low';
  return 'normal';
}

function mapEPIStatusToDb(status: EPIStatus): string {
  if (status === 'out_of_stock') return 'esgotado';
  if (status === 'low') return 'baixo';
  return 'normal';
}

// Map Prisma EPI model → TypeScript EPIItem
function mapPrismaEPI(e: any): EPIItem {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    category: e.category as any,
    unit: e.unit,
    currentQty: e.currentQty,
    minQty: e.minQty,
    location: e.location,
    manufacturer: e.manufacturer ?? undefined,
    notes: e.notes ?? undefined,
    updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : e.updatedAt,
    status: mapDbStatusToEPIStatus(e.status),
    businessUnitId: e.businessUnitId ?? undefined,
    businessUnitName: e.businessUnit?.name ?? undefined,
    businessUnitType: e.businessUnit?.type as any,
  };
}

// Map Prisma User model → TypeScript User
function mapPrismaUser(u: any): User {
  const permissions = normalizeAccessPolicy(u.permissions);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as any,
    status: u.status as User['status'],
    permissions: permissions ?? {},
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
    lastLogin: u.lastLogin ? (u.lastLogin instanceof Date ? u.lastLogin.toISOString() : u.lastLogin) : undefined,
    department: u.department ?? undefined,
    businessUnitId: u.businessUnitId ?? undefined,
    businessUnitName: u.businessUnit?.name ?? undefined,
    businessUnitType: u.businessUnit?.type as any,
  };
}

// Map Prisma Movement → TypeScript Movement
function mapPrismaMovement(m: any): Movement {
  return {
    id: m.id,
    epiId: m.epiId,
    epiCode: m.epiCode,
    epiName: m.epiName,
    type: m.type as any,
    quantity: m.quantity,
    responsibleId: m.responsibleId ?? '',
    responsibleName: m.responsibleName,
    reason: m.reason ?? '',
    recipient: m.recipient ?? undefined,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    notes: m.notes ?? undefined,
    businessUnitId: m.businessUnitId ?? undefined,
    businessUnitName: m.businessUnit?.name ?? undefined,
  };
}

// Map Prisma AuditLog → TypeScript AuditLog
function mapPrismaLog(l: any): AuditLog {
  return {
    id: l.id,
    timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
    userId: l.userId ?? '',
    userName: l.userName,
    userRole: l.userRole as any,
    action: l.action,
    details: l.details,
    module: l.module,
  };
}

// Map Prisma Notification → TypeScript EmailNotification
function mapPrismaNotification(n: any): EmailNotification {
  return {
    id: n.id,
    timestamp: n.timestamp instanceof Date ? n.timestamp.toISOString() : n.timestamp,
    recipient: n.recipient,
    subject: n.subject,
    body: n.body,
    type: n.type as any,
    read: n.read,
  };
}

// Utility to add an audit log in the database
type AuditModule = 'system' | 'epi' | 'formula' | 'packaging';

async function addAuditLog(
  userId: string,
  userName: string,
  userRole: string,
  action: string,
  details: string,
  module: AuditModule,
) {
  if (!useDatabase || !prisma) {
    console.warn('⚠️ Banco não disponível; não foi possível registrar o audit log.');
    return;
  }

  try {
    const users = userId && userId !== 'admin' && userId !== 'system' && userId !== 'user'
      ? await prisma.$queryRaw<{ companyId: string }[]>`
          SELECT "companyId"
          FROM "User"
          WHERE "id" = ${userId}
          LIMIT 1
        `
      : [];
    const companyId = users[0]?.companyId;

    if (!companyId) {
      console.warn(`⚠️ Audit log ignorado: não foi possível identificar a empresa do usuário "${userId}".`);
      return;
    }

    await prisma.$executeRaw`
      INSERT INTO "AuditLog" ("id", "userId", "userName", "userRole", "action", "details", "module", "companyId")
      VALUES (${randomUUID()}, ${userId}, ${userName}, ${userRole}, ${action}, ${details}, ${module}, ${companyId})
    `;
  } catch (err) {
    console.error('Erro ao salvar audit log:', err);
  }
}

interface PackagingActor {
  id: string;
  name: string;
  role: string;
  companyId: string;
  permissions: unknown;
}

async function resolvePackagingActor(req: express.Request, res: express.Response): Promise<PackagingActor | null> {
  if (!useDatabase || !prisma) {
    res.status(503).json({ error: 'Banco de dados não configurado.' });
    return null;
  }

  const authorization = req.headers.authorization;
  const tokenMatch = authorization?.match(/^Bearer fmt_(.+)_(\d+)$/);
  if (!tokenMatch || Date.now() > Number(tokenMatch[2])) {
    res.status(401).json({ error: 'Sessão inválida ou expirada.' });
    return null;
  }

  const users = await prisma.$queryRaw<PackagingActor[]>`
    SELECT "id", "name", "role", "companyId", "permissions"
    FROM "User"
    WHERE "id" = ${tokenMatch[1]} AND "status" = 'active'
    LIMIT 1
  `;
  if (!users[0]) {
    res.status(401).json({ error: 'Usuário inválido ou inativo.' });
    return null;
  }

  const permissions = normalizeAccessPolicy(users[0].permissions);
  if (!permissions) {
    console.error(`Política de acesso inválida para o usuário "${users[0].id}".`);
    res.status(403).json({ error: 'A política de acesso da conta está inválida. Entre em contato com o Master.' });
    return null;
  }

  return { ...users[0], permissions };
}

function requirePermission(
  actor: PackagingActor,
  res: express.Response,
  module: AccessModule,
  operation: AccessOperation,
): boolean {
  if (canAccess(actor.role, actor.permissions, { module, operation })) return true;
  res.status(403).json({ error: 'Você não possui permissão para realizar esta operação.' });
  return false;
}

function requireMaster(actor: PackagingActor, res: express.Response): boolean {
  if (actor.role === 'master') return true;
  res.status(403).json({ error: 'Somente o Master pode administrar usuários e permissões.' });
  return false;
}

let masterBootstrap: Promise<void> | null = null;

async function bootstrapInitialMaster(): Promise<void> {
  if (!useDatabase || !prisma) return;

  const email = 'adm@farmaflow.com';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.role === 'master') return;

  const password = process.env.MASTER_INITIAL_PASSWORD;
  if (!password) {
    throw new Error(`Configure MASTER_INITIAL_PASSWORD (mínimo de 12 caracteres) para provisionar ${email} como Master.`);
  }
  if (!isValidPassword(password)) {
    throw new Error('MASTER_INITIAL_PASSWORD deve possuir no mínimo 12 caracteres.');
  }

  const company = await prisma.company.findFirst({ orderBy: { createdAt: 'asc' } })
    ?? await prisma.company.create({
      data: { id: randomUUID(), name: 'FarmaFlow', updatedAt: new Date() },
    });
  const hashedPassword = await hashPassword(password);
  let masterId: string;

  if (existing) {
    const master = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: process.env.MASTER_INITIAL_NAME?.trim() || 'Master FarmaFlow',
        password: hashedPassword,
        role: 'master',
        status: 'active',
        permissions: {},
      },
    });
    masterId = master.id;
  } else {
    const master = await prisma.user.create({
      data: {
        name: process.env.MASTER_INITIAL_NAME?.trim() || 'Master FarmaFlow',
        email,
        password: hashedPassword,
        role: 'master',
        status: 'active',
        permissions: {},
        department: 'Administração',
        companyId: company.id,
      },
    });
    masterId = master.id;
  }

  await addAuditLog(masterId, process.env.MASTER_INITIAL_NAME?.trim() || 'Master FarmaFlow', 'master', 'Conta Master inicial provisionada', `Conta ${email} provisionada como autoridade Master da empresa.`, 'system');
  console.log(`✅ Conta Master inicial provisionada: ${email}.`);
}

function ensureInitialMaster(): Promise<void> {
  if (!masterBootstrap) masterBootstrap = bootstrapInitialMaster();
  return masterBootstrap;
}

app.use('/api', async (req, res, next) => {
  try {
    await ensureInitialMaster();
    const apiPath = req.originalUrl.split('?', 1)[0];
    if (isApiRoutePublic(req.method, apiPath)) return next();

    const actor = await resolvePackagingActor(req, res);
    if (!actor) return;

    if (actor.role === 'master') return next();

    const requirement = getApiAccessRequirement(req.method, apiPath, req.query);
    if (!requirement || !canAccess(actor.role, actor.permissions, requirement)) {
      return res.status(403).json({ error: 'Acesso negado. Seu perfil não possui esta concessão.' });
    }

    return next();
  } catch (err) {
    console.error('Erro ao validar concessão de acesso:', err);
    return res.status(500).json({ error: 'Não foi possível validar as permissões desta solicitação.' });
  }
});

function mapPackagingRow(row: Record<string, any>) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    type: row.type,
    material: row.material,
    unit: row.unit,
    capacity: row.capacity === null ? undefined : Number(row.capacity),
    capacityUnit: row.capacityUnit ?? undefined,
    dimensions: row.dimensions ?? undefined,
    manufacturer: row.manufacturer ?? undefined,
    location: row.location,
    currentQty: Number(row.currentQty),
    minQty: Number(row.minQty),
    unitCost: row.unitCost === null ? undefined : Number(row.unitCost),
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function mapPackagingMovementRow(row: Record<string, any>) {
  return {
    id: row.id,
    packagingId: row.packagingId,
    packagingCode: row.packagingCode,
    packagingName: row.packagingName,
    type: row.type,
    quantity: Number(row.quantity),
    responsibleId: row.responsibleId ?? undefined,
    responsibleName: row.responsibleName,
    recipient: row.recipient ?? undefined,
    reason: row.reason ?? undefined,
    notes: row.notes ?? undefined,
    date: row.date instanceof Date ? row.date.toISOString() : row.date,
  };
}

interface PackagingInput {
  code: string;
  name: string;
  category: string;
  type: string;
  material: string;
  unit: string;
  capacity: number | null;
  capacityUnit: string | null;
  dimensions: string | null;
  manufacturer: string | null;
  location: string;
  currentQty: number;
  minQty: number;
  unitCost: number | null;
  status: 'active' | 'inactive';
}

function parsePackagingInput(value: unknown): { data?: PackagingInput; error?: string } {
  if (!value || typeof value !== 'object') return { error: 'Informe os dados da embalagem.' };
  const body = value as Record<string, unknown>;
  const required = ['code', 'name', 'category', 'type', 'material', 'unit', 'location'];
  if (required.some((key) => typeof body[key] !== 'string' || !(body[key] as string).trim())) {
    return { error: 'Preencha todos os campos obrigatórios da embalagem.' };
  }

  const numberValue = (key: string, allowEmpty = false): number | null | undefined => {
    const raw = body[key];
    if ((raw === undefined || raw === null || raw === '') && allowEmpty) return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    return raw;
  };
  const currentQty = numberValue('currentQty');
  const minQty = numberValue('minQty');
  const capacity = numberValue('capacity', true);
  const unitCost = numberValue('unitCost', true);
  if (!Number.isInteger(currentQty) || currentQty! < 0 || !Number.isInteger(minQty) || minQty! < 0) {
    return { error: 'Estoque atual e mínimo devem ser números inteiros iguais ou maiores que zero.' };
  }
  if (capacity === undefined || (capacity !== null && capacity <= 0) || unitCost === undefined || (unitCost !== null && unitCost < 0)) {
    return { error: 'Capacidade e custo devem conter valores válidos.' };
  }
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'inactive') {
    return { error: 'Status da embalagem inválido.' };
  }

  const text = (key: string) => typeof body[key] === 'string' && (body[key] as string).trim()
    ? (body[key] as string).trim()
    : null;
  return {
    data: {
      code: (body.code as string).trim(),
      name: (body.name as string).trim(),
      category: (body.category as string).trim(),
      type: (body.type as string).trim(),
      material: (body.material as string).trim(),
      unit: (body.unit as string).trim(),
      capacity: capacity as number | null,
      capacityUnit: text('capacityUnit'),
      dimensions: text('dimensions'),
      manufacturer: text('manufacturer'),
      location: (body.location as string).trim(),
      currentQty: currentQty!,
      minQty: minQty!,
      unitCost: unitCost as number | null,
      status: body.status === 'inactive' ? 'inactive' : 'active',
    },
  };
}

// Helper function to send email via Resend API
async function sendResendEmail(to: string, subject: string, textBody: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ RESEND_API_KEY não configurada no .env. Ignorando envio real de e-mail.');
    return;
  }

  // O domínio gratuito do Resend (onboarding@resend.dev) envia apenas para o e-mail cadastrado na conta.
  // Faremos um fallback inteligente caso os e-mails dos administradores não sejam autorizados na Sandbox.
  const toList = to.split(',').map(email => email.trim());

  // Formata o corpo do e-mail em HTML
  const htmlBody = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
      <h2 style="color: #0f2c59; border-bottom: 2px solid #059669; padding-bottom: 10px; margin-top: 0; display: flex; align-items: center; gap: 8px;">
        🛡️ FORMULA EPI - Alerta de Estoque
      </h2>
      <div style="white-space: pre-wrap; font-size: 14px; color: #334155; line-height: 1.6; background-color: #f8fafc; padding: 15px; border-radius: 8px; border: 1px solid #f1f5f9;">${textBody.replace(/\n/g, '<br>')}</div>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">Esta é uma notificação automática gerada pelo sistema de Gestão de Estoque FormulaEpi.</p>
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'FormulaEPI <onboarding@resend.dev>',
        to: toList,
        subject: subject,
        html: htmlBody
      })
    });

    if (response.ok) {
      const data: unknown = await response.json();
      const emailId = typeof data === 'object' && data !== null && 'id' in data && typeof data.id === 'string'
        ? data.id
        : 'não informado';
      console.log(`✉️ E-mail enviado com sucesso via Resend! ID: ${emailId}`);
    } else {
      const errText = await response.text();
      console.error(`❌ Erro no envio de e-mail via Resend (Status ${response.status}):`, errText);
    }
  } catch (err) {
    console.error('❌ Falha de conexão ao tentar enviar e-mail via Resend:', err);
  }
}

// Utility to trigger auto-email notification
async function triggerEmailNotification(epi: EPIItem, previousQty: number, companyId: string) {
  const type = getStockAlertType(epi.currentQty, previousQty, epi.minQty);
  let subject = '';
  let body = '';

  let recipientEmail = process.env.RESEND_TO_EMAIL || 'formulaplus.developer@gmail.com';

  if (type === 'out_of_stock') {
    subject = `🚨 URGENTE: Produto Esgotado - ${epi.name}`;
    body = `Atenção Administrador,\n\nO produto abaixo ESGOTOU COMPLETAMENTE no estoque:\n\n• Produto: ${epi.name} (${epi.code})\n• Categoria: ${epi.category}\n• Quantidade Atual: 0 ${epi.unit}\n• Quantidade Mínima: ${epi.minQty} ${epi.unit}\n• Localização: ${epi.location}\n• Data do Alerta: ${new Date().toLocaleString('pt-BR')}\n\nPor favor, providencie a emissão do pedido de compra de reposição.`;
  } else if (type === 'low_stock') {
    subject = `⚠️ ALERTA: Estoque Mínimo Atingido - ${epi.name}`;
    body = `Atenção Administrador,\n\nO produto abaixo atingiu ou ficou abaixo da quantidade mínima configurada:\n\n• Produto: ${epi.name} (${epi.code})\n• Categoria: ${epi.category}\n• Quantidade Atual: ${epi.currentQty} ${epi.unit}\n• Quantidade Mínima: ${epi.minQty} ${epi.unit}\n• Localização: ${epi.location}\n• Data do Alerta: ${new Date().toLocaleString('pt-BR')}\n\nRecomenda-se providenciar o reabastecimento antes que o item esgote.`;
  }

  if (type) {
    if (useDatabase && prisma) {
      try {
        await prisma.notification.create({
          data: {
            recipient: recipientEmail,
            subject,
            body,
            type,
            read: false,
            epiId: epi.id,
            companyId,
          },
        });
      } catch (err) {
        console.error('Erro ao salvar notificação:', err);
      }
    } else {
      console.warn('⚠️ Banco não disponível; a notificação não foi persistida.');
    }

    // Dispara o envio real de e-mail em background via Resend API
    sendResendEmail(recipientEmail, subject, body);

    await addAuditLog('system', 'Sistema de Notificações', 'admin', `Notificação Enviada (${type})`, `Disparado e-mail para ${recipientEmail}: ${subject}`, 'system');
  }
}



// =================== API ROUTES ===================

// =================== PACKAGING ===================

app.get('/api/packagings', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma) return;
    const rows = await prisma.$queryRaw<Record<string, any>[]>`
      SELECT * FROM "Packaging"
      WHERE "companyId" = ${actor.companyId}
      ORDER BY "name" ASC
    `;
    return res.json(rows.map(mapPackagingRow));
  } catch (err) {
    console.error('Erro ao buscar embalagens:', err);
    return res.status(500).json({ error: 'Não foi possível carregar o catálogo de embalagens.' });
  }
});

app.get('/api/packagings/movements', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma) return;
    const rows = await prisma.$queryRaw<Record<string, any>[]>`
      SELECT * FROM "PackagingMovement"
      WHERE "companyId" = ${actor.companyId}
      ORDER BY "date" DESC
      LIMIT 500
    `;
    return res.json(rows.map(mapPackagingMovementRow));
  } catch (err) {
    console.error('Erro ao buscar movimentações de embalagens:', err);
    return res.status(500).json({ error: 'Não foi possível carregar o histórico de embalagens.' });
  }
});

app.get('/api/packagings/audit', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma) return;
    const rows = await prisma.$queryRaw<Record<string, any>[]>`
      SELECT "id", "timestamp", "userId", "userName", "userRole", "action", "details", "module"
      FROM "AuditLog"
      WHERE "companyId" = ${actor.companyId} AND "module" = 'packaging'
      ORDER BY "timestamp" DESC
      LIMIT 500
    `;
    return res.json(rows.map((row) => ({
      ...row,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      userId: row.userId ?? '',
    })));
  } catch (err) {
    console.error('Erro ao buscar auditoria de embalagens:', err);
    return res.status(500).json({ error: 'Não foi possível carregar a auditoria de embalagens.' });
  }
});

app.post('/api/packagings', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma || !requirePermission(actor, res, 'packagings', 'create')) return;
    const parsed = parsePackagingInput(req.body);
    if (!parsed.data) return res.status(400).json({ error: parsed.error });
    const item = parsed.data;
    const id = randomUUID();

    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Packaging" (
          "id", "code", "name", "category", "type", "material", "unit", "capacity",
          "capacityUnit", "dimensions", "manufacturer", "location", "currentQty", "minQty",
          "unitCost", "status", "companyId", "updatedAt"
        ) VALUES (
          ${id}, ${item.code}, ${item.name}, ${item.category}, ${item.type}, ${item.material},
          ${item.unit}, ${item.capacity}, ${item.capacityUnit}, ${item.dimensions}, ${item.manufacturer},
          ${item.location}, ${item.currentQty}, ${item.minQty}, ${item.unitCost}, ${item.status},
          ${actor.companyId}, CURRENT_TIMESTAMP
        )
      `;
      if (item.currentQty > 0) {
        await tx.$executeRaw`
          INSERT INTO "PackagingMovement" (
            "id", "packagingId", "packagingCode", "packagingName", "type", "quantity",
            "responsibleId", "responsibleName", "reason", "companyId"
          ) VALUES (
            ${randomUUID()}, ${id}, ${item.code}, ${item.name}, 'entrada', ${item.currentQty},
            ${actor.id}, ${actor.name}, 'Estoque inicial', ${actor.companyId}
          )
        `;
      }
      const rows = await tx.$queryRaw<Record<string, any>[]>`
        SELECT * FROM "Packaging" WHERE "id" = ${id} AND "companyId" = ${actor.companyId}
      `;
      return rows[0];
    });
    await addAuditLog(actor.id, actor.name, actor.role, 'Embalagem cadastrada', `Código ${item.code}`, 'packaging');
    return res.status(201).json(mapPackagingRow(created));
  } catch (err) {
    console.error('Erro ao cadastrar embalagem:', err);
    return res.status(500).json({ error: 'Não foi possível cadastrar a embalagem. Verifique se o código já está em uso.' });
  }
});

app.put('/api/packagings/:id', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma || !requirePermission(actor, res, 'packagings', 'edit')) return;
    const parsed = parsePackagingInput(req.body);
    if (!parsed.data) return res.status(400).json({ error: parsed.error });
    const item = parsed.data;
    const id = req.params.id;

    const updated = await prisma.$transaction(async (tx) => {
      const existingRows = await tx.$queryRaw<Record<string, any>[]>`
        SELECT * FROM "Packaging" WHERE "id" = ${id} AND "companyId" = ${actor.companyId} FOR UPDATE
      `;
      const existing = existingRows[0];
      if (!existing) return null;
      const previousQty = Number(existing.currentQty);
      const delta = item.currentQty - previousQty;
      await tx.$executeRaw`
        UPDATE "Packaging" SET
          "code" = ${item.code}, "name" = ${item.name}, "category" = ${item.category},
          "type" = ${item.type}, "material" = ${item.material}, "unit" = ${item.unit},
          "capacity" = ${item.capacity}, "capacityUnit" = ${item.capacityUnit},
          "dimensions" = ${item.dimensions}, "manufacturer" = ${item.manufacturer},
          "location" = ${item.location}, "currentQty" = ${item.currentQty}, "minQty" = ${item.minQty},
          "unitCost" = ${item.unitCost}, "status" = ${item.status}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${id} AND "companyId" = ${actor.companyId}
      `;
      if (delta !== 0) {
        await tx.$executeRaw`
          INSERT INTO "PackagingMovement" (
            "id", "packagingId", "packagingCode", "packagingName", "type", "quantity",
            "responsibleId", "responsibleName", "reason", "companyId"
          ) VALUES (
            ${randomUUID()}, ${id}, ${item.code}, ${item.name}, ${delta > 0 ? 'entrada' : 'saida'},
            ${Math.abs(delta)}, ${actor.id}, ${actor.name}, 'Ajuste de estoque pelo cadastro',
            ${actor.companyId}
          )
        `;
      }
      const rows = await tx.$queryRaw<Record<string, any>[]>`
        SELECT * FROM "Packaging" WHERE "id" = ${id} AND "companyId" = ${actor.companyId}
      `;
      return rows[0];
    });

    if (!updated) return res.status(404).json({ error: 'Embalagem não encontrada.' });
    await addAuditLog(actor.id, actor.name, actor.role, 'Embalagem atualizada', `Código ${item.code}`, 'packaging');
    return res.json(mapPackagingRow(updated));
  } catch (err) {
    console.error('Erro ao atualizar embalagem:', err);
    return res.status(500).json({ error: 'Não foi possível atualizar a embalagem. Verifique se o código já está em uso.' });
  }
});

app.delete('/api/packagings/:id', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma || !requirePermission(actor, res, 'packagings', 'delete')) return;
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Packaging" WHERE "id" = ${req.params.id} AND "companyId" = ${actor.companyId}
    `;
    if (!deleted) return res.status(404).json({ error: 'Embalagem não encontrada.' });
    await addAuditLog(actor.id, actor.name, actor.role, 'Embalagem excluída', `ID ${req.params.id}`, 'packaging');
    return res.json({ success: true, message: 'Embalagem excluída com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir embalagem:', err);
    return res.status(409).json({ error: 'Não foi possível excluir a embalagem. Remova ou preserve o histórico de movimentações.' });
  }
});

app.post('/api/packagings/movements', async (req, res) => {
  try {
    const actor = await resolvePackagingActor(req, res);
    if (!actor || !prisma) return;
    if (!requirePermission(actor, res, 'packaging-movements', 'create')) return;

    const { packagingId, type, quantity, recipient, reason, notes } = req.body ?? {};
    if (typeof packagingId !== 'string' || !packagingId || !['entrada', 'saida'].includes(type)
      || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'Informe uma embalagem, o tipo de operação e uma quantidade inteira maior que zero.' });
    }
    const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

    const result = await prisma.$transaction(async (tx) => {
      const packagingRows = await tx.$queryRaw<Record<string, any>[]>`
        SELECT * FROM "Packaging" WHERE "id" = ${packagingId} AND "companyId" = ${actor.companyId} FOR UPDATE
      `;
      const packaging = packagingRows[0];
      if (!packaging) return { error: 'Embalagem não encontrada.', status: 404 as const };
      if (packaging.status !== 'active') return { error: 'Não é possível movimentar uma embalagem inativa.', status: 400 as const };
      const oldQty = Number(packaging.currentQty);
      const updatedQty = type === 'entrada' ? oldQty + quantity : oldQty - quantity;
      if (updatedQty < 0) return { error: 'Saldo insuficiente para realizar esta saída.', status: 409 as const };

      await tx.$executeRaw`
        UPDATE "Packaging" SET "currentQty" = ${updatedQty}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${packagingId} AND "companyId" = ${actor.companyId}
      `;
      await tx.$executeRaw`
        INSERT INTO "PackagingMovement" (
          "id", "packagingId", "packagingCode", "packagingName", "type", "quantity",
          "responsibleId", "responsibleName", "recipient", "reason", "notes", "companyId"
        ) VALUES (
          ${randomUUID()}, ${packagingId}, ${packaging.code}, ${packaging.name}, ${type}, ${quantity},
          ${actor.id}, ${actor.name}, ${optionalText(recipient)}, ${optionalText(reason)},
          ${optionalText(notes)}, ${actor.companyId}
        )
      `;
      const [movementRows, updatedRows] = await Promise.all([
        tx.$queryRaw<Record<string, any>[]>`
          SELECT * FROM "PackagingMovement" WHERE "packagingId" = ${packagingId}
            AND "companyId" = ${actor.companyId} ORDER BY "date" DESC LIMIT 1
        `,
        tx.$queryRaw<Record<string, any>[]>`
          SELECT * FROM "Packaging" WHERE "id" = ${packagingId} AND "companyId" = ${actor.companyId}
        `,
      ]);
      return { movement: movementRows[0], packaging: updatedRows[0] };
    });

    if ('error' in result) return res.status(result.status).json({ error: result.error });
    await addAuditLog(actor.id, actor.name, actor.role, `Embalagem - ${type}`, `${quantity} ${result.packaging.unit} de ${result.packaging.name}`, 'packaging');
    return res.status(201).json({
      movement: mapPackagingMovementRow(result.movement),
      updatedPackaging: mapPackagingRow(result.packaging),
    });
  } catch (err) {
    console.error('Erro ao registrar movimentação de embalagem:', err);
    return res.status(500).json({ error: 'Não foi possível registrar a movimentação.' });
  }
});

// Database Status
app.get('/api/database-status', (_req, res) => {
  res.json(getDatabaseStatus());
});

// Reset Demo Data
app.post('/api/reset-demo-data', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado. Configure DATABASE_URL para restaurar os dados.' });
  }

  try {
    await prisma.notification.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.movement.deleteMany();
    await prisma.ePI.deleteMany();
    await prisma.user.deleteMany({ where: { role: { not: 'master' } } });

    const { execSync } = await import('child_process');
    execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', cwd: __dirname });

    return res.json({ success: true, message: 'Banco de dados restaurado com dados iniciais!' });
  } catch (err) {
    console.error('Erro ao resetar banco:', err);
    return res.status(500).json({ error: 'Erro ao resetar banco de dados.' });
  }
});

// =================== BUSINESS UNITS ===================

app.get('/api/business-units', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(_req, res);
  if (!actor) return;

  try {
    let units = await prisma.businessUnit.findMany({
      where: { companyId: actor.companyId },
      orderBy: { createdAt: 'asc' },
    });
    const hasMatriz = units.some((u) => u.type === 'matriz');
    if (!hasMatriz) {
      const defaultMatriz = await prisma.businessUnit.create({
        data: {
          id: 'bu-matriz',
          name: 'Matriz',
          code: 'MAT',
          type: 'matriz',
          active: true,
          companyId: actor.companyId,
        },
      });
      units.unshift(defaultMatriz);
    }
    return res.json(units);
  } catch (err) {
    console.error('Erro ao buscar unidades:', err);
    return res.status(500).json({ error: 'Erro ao buscar unidades do banco.' });
  }
});

app.post('/api/business-units', async (req, res) => {
  const { name, type = 'filial' } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'O nome da unidade é obrigatório.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'business-units', 'create')) return;

  const normalizedName = name.trim();
  const unitType = type === 'matriz' ? 'matriz' : 'filial';
  const code = `BU${Date.now().toString().slice(-4)}`.toUpperCase();

  try {
    const created = await prisma.businessUnit.create({
      data: {
        name: normalizedName,
        type: unitType,
        code,
        active: true,
        companyId: actor.companyId,
      },
    });
    return res.status(201).json(created);
  } catch (err) {
    console.error('Erro ao criar unidade:', err);
    return res.status(500).json({ error: 'Erro ao criar unidade no banco.' });
  }
});

app.delete('/api/business-units/:id', async (req, res) => {
  const { id } = req.params;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  if (id === 'bu-matriz' || id === 'matriz') {
    return res.status(400).json({ error: 'A matriz não pode ser removida.' });
  }

  try {
    const unitEpis = await prisma.ePI.findMany({
      where: { businessUnitId: id },
      select: { id: true },
    });
    const epiIds = unitEpis.map((e) => e.id);

    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { epiId: { in: epiIds } } }),
      prisma.movement.deleteMany({ where: { businessUnitId: id } }),
      prisma.ePI.deleteMany({ where: { businessUnitId: id } }),
      prisma.user.deleteMany({ where: { businessUnitId: id } }),
      prisma.businessUnit.delete({ where: { id } }),
    ]);

    return res.json({ success: true, message: 'Unidade e todos os dados vinculados excluídos com sucesso.' });
  } catch (err) {
    console.error('Erro ao excluir unidade:', err);
    return res.status(500).json({ error: 'Erro ao excluir unidade no banco.' });
  }
});

// =================== AUTH ===================

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const expiresInMs = 8 * 60 * 60 * 1000;
  const expiresAt = Date.now() + expiresInMs;

  try {
    const dbUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!dbUser || !(await verifyPassword(password, dbUser.password))) {
      return res.status(401).json({ error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
    }

    if (dbUser.status !== 'active') {
      return res.status(403).json({ error: 'Conta pendente ou desativada. Entre em contato com o Master.' });
    }

    const passwordUpdate = dbUser.password.startsWith('scrypt$')
      ? {}
      : { password: await hashPassword(password) };
    const loggedInUser = await prisma.user.update({
      where: { id: dbUser.id },
      data: { ...passwordUpdate, lastLogin: new Date() },
    });
    await addAuditLog(dbUser.id, dbUser.name, dbUser.role, 'Login Realizado', `Sessão autenticada via e-mail: ${dbUser.email}`, 'system');

    const token = `fmt_${dbUser.id}_${expiresAt}`;
    return res.json({
      user: mapPrismaUser(loggedInUser),
      token,
      expiresAt,
    });
  } catch (err) {
    console.error('Erro no login via banco:', err);
    return res.status(500).json({ error: 'Erro ao autenticar no banco de dados.' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de sessão não fornecido.' });
  }

  const token = authHeader.split(' ')[1];
  const parts = token.split('_');

  if (parts.length < 3 || parts[0] !== 'fmt') {
    return res.status(401).json({ error: 'Token com formato inválido.' });
  }

  const userId = parts[1];
  const expiresAt = Number(parts[2]);

  if (Date.now() > expiresAt) {
    return res.status(401).json({ error: 'Sessão expirada. Por favor, faça login novamente.' });
  }

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') {
      return res.status(401).json({ error: 'Usuário inválido ou inativo.' });
    }
    return res.json({ user: mapPrismaUser(user), expiresAt });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao validar token de sessão.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  await addAuditLog(actor.id, actor.name, actor.role, 'Logout Realizado', 'Sessão encerrada pelo usuário.', 'system');
  return res.json({ success: true });
});

app.post('/api/auth/recover-password', async (req, res) => {
  const { email } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const dbUser = await prisma.user.findUnique({ where: { email: (email || '').toLowerCase() } });
  if (!dbUser) return res.status(404).json({ error: 'Nenhum usuário cadastrado com este e-mail.' });

  const user = mapPrismaUser(dbUser);
  const token = Math.floor(100000 + Math.random() * 900000).toString();
  passwordResetTokens[token] = { email: user.email, expires: Date.now() + 15 * 60 * 1000 };

  await prisma.notification.create({
    data: {
      recipient: user.email,
      subject: '🔑 Código para Recuperação de Senha - Sistema de EPIs',
      body: `Olá ${user.name},\n\nRecebemos uma solicitação de redefinição de senha para sua conta.\n\nSeu código de verificação é: ${token}\nEste código é válido por 15 minutos.\n\nSe você não solicitou a alteração, ignore esta mensagem.`,
      type: 'general',
      read: false,
      companyId: dbUser.companyId,
    },
  });

  await addAuditLog(user.id, user.name, user.role, 'Solicitação de Recuperação de Senha', `Código de recuperação gerado para ${user.email}`, 'system');

  return res.json({
    success: true,
    message: 'E-mail de recuperação enviado! Verifique seu código na central de notificações.',
    tokenDemo: token,
  });
});


app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});



app.post('/api/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  const tokenData = passwordResetTokens[token];
  if (!tokenData || tokenData.expires < Date.now()) return res.status(400).json({ error: 'Código de recuperação inválido ou expirado.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const dbUser = await prisma.user.findUnique({ where: { email: tokenData.email } });
  if (!dbUser) return res.status(404).json({ error: 'Usuário não encontrado.' });

  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'A senha deve possuir no mínimo 12 caracteres.' });
  }

  await prisma.user.update({ where: { id: dbUser.id }, data: { password: await hashPassword(newPassword) } });
  await addAuditLog(dbUser.id, dbUser.name, dbUser.role, 'Senha Redefinida', 'Senha alterada com sucesso via código de verificação.', 'system');
  delete passwordResetTokens[token];
  return res.json({ success: true, message: 'Senha redefinida com sucesso! Você já pode realizar o login.' });
});

// =================== USERS ===================

app.get('/api/users', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(_req, res);
  if (!actor || !requireMaster(actor, res)) return;

  try {
    const dbUsers = await prisma.user.findMany({
      where: { companyId: actor.companyId },
      orderBy: { createdAt: 'desc' },
      include: { businessUnit: true },
    });
    return res.json(dbUsers.map(mapPrismaUser));
  } catch (err) {
    console.error('Erro ao buscar usuários:', err);
    return res.status(500).json({ error: 'Erro ao buscar usuários do banco.' });
  }
});

app.post('/api/users', async (req, res) => {
  const { name, email, role, password, permissions, status, department, businessUnitId } = req.body ?? {};
  const normalizedPermissions = normalizeAccessPolicy(permissions);
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    || !['admin', 'operador', 'visualizador'].includes(role) || !isValidPassword(password)
    || !normalizedPermissions || !['active', 'pending', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'Informe nome, e-mail válido, senha com no mínimo 12 caracteres, perfil, status e concessões válidas.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requireMaster(actor, res)) return;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    if (businessUnitId) {
      const unit = await prisma.businessUnit.findFirst({
        where: { id: businessUnitId, companyId: actor.companyId },
        select: { id: true },
      });
      if (!unit) return res.status(400).json({ error: 'A unidade selecionada não pertence à empresa atual.' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(400).json({ error: 'Já existe um usuário cadastrado com este e-mail.' });

    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: await hashPassword(password),
        role,
        status,
        permissions: normalizedPermissions,
        department: department || 'Operacional',
        businessUnitId: businessUnitId || null,
        companyId: actor.companyId,
      },
    });
    await addAuditLog(
      actor.id,
      actor.name,
      actor.role,
      'Novo Usuário Criado',
      `Criado usuário ${name.trim()} (${normalizedEmail}) com perfil ${role}, status ${status} e concessões ${JSON.stringify(normalizedPermissions)}.`,
      'system',
    );
    return res.status(201).json(mapPrismaUser(newUser));
  } catch (err) {
    console.error('Erro ao criar usuário:', err);
    return res.status(500).json({ error: 'Erro ao criar usuário no banco.' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, role, password, permissions, status, department, businessUnitId } = req.body ?? {};

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requireMaster(actor, res)) return;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const existing = await prisma.user.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (existing.role === 'master') {
      return res.status(403).json({ error: 'A conta Master não pode ser alterada ou removida pela gestão de usuários.' });
    }
    if ((role !== undefined && !['admin', 'operador', 'visualizador'].includes(role))
      || (status !== undefined && !['active', 'pending', 'inactive'].includes(status))
      || (email !== undefined && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())))
      || (name !== undefined && (typeof name !== 'string' || !name.trim()))
      || (password !== undefined && !isValidPassword(password))) {
      return res.status(400).json({ error: 'Os dados informados são inválidos. Senhas devem possuir no mínimo 12 caracteres.' });
    }
    const normalizedPermissions = permissions === undefined ? undefined : normalizeAccessPolicy(permissions);
    if (permissions !== undefined && !normalizedPermissions) {
      return res.status(400).json({ error: 'A política contém módulos ou operações inválidos.' });
    }
    if (businessUnitId) {
      const unit = await prisma.businessUnit.findFirst({
        where: { id: businessUnitId, companyId: actor.companyId },
        select: { id: true },
      });
      if (!unit) return res.status(400).json({ error: 'A unidade selecionada não pertence à empresa atual.' });
    }
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(email !== undefined && { email: email.trim().toLowerCase() }),
        ...(role && { role }),
        ...(status && { status }),
        ...(password !== undefined && { password: await hashPassword(password) }),
        ...(normalizedPermissions !== undefined && { permissions: normalizedPermissions }),
        ...(department !== undefined && { department }),
        ...(businessUnitId !== undefined && { businessUnitId: businessUnitId === '' ? null : businessUnitId }),
      },
    });
    await addAuditLog(
      actor.id,
      actor.name,
      actor.role,
      'Usuário Atualizado',
      `Atualizados dados, status e/ou concessões do usuário ${updated.name} (${updated.email}). Concessões: ${JSON.stringify(updated.permissions)}.`,
      'system',
    );
    return res.json(mapPrismaUser(updated));
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Usuário não encontrado.' });
    console.error('Erro ao atualizar usuário:', err);
    return res.status(500).json({ error: 'Erro ao atualizar usuário no banco.' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requireMaster(actor, res)) return;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const existing = await prisma.user.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (existing.role === 'master') {
      return res.status(403).json({ error: 'A conta Master não pode ser excluída.' });
    }
    const deleted = await prisma.user.delete({ where: { id: existing.id } });
    await addAuditLog(actor.id, actor.name, actor.role, 'Usuário Excluído', `Removido usuário ${deleted.name} (${deleted.email}).`, 'system');
    return res.json({ success: true, message: 'Usuário excluído com sucesso.' });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Usuário não encontrado.' });
    return res.status(500).json({ error: 'Erro ao excluir usuário do banco.' });
  }
});

// =================== EPIs ===================

app.get('/api/epis', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(_req, res);
  if (!actor) return;

  try {
    const dbEpis = await prisma.ePI.findMany({
      where: { companyId: actor.companyId },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(dbEpis.map(mapPrismaEPI));
  } catch (err) {
    console.error('Erro ao buscar EPIs:', err);
    return res.status(500).json({ error: 'Erro ao buscar EPIs do banco.' });
  }
});

app.post('/api/epis', async (req, res) => {
  const { code, name, category, unit, currentQty, minQty, location, manufacturer, notes, businessUnitId } = req.body;
  if (!name || !category || !unit) return res.status(400).json({ error: 'Nome, categoria e unidade de medida são obrigatórios.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'epis', 'create')) return;

  if (businessUnitId) {
    const unit = await prisma.businessUnit.findFirst({
      where: { id: businessUnitId, companyId: actor.companyId },
      select: { id: true },
    });
    if (!unit) return res.status(400).json({ error: 'A unidade selecionada não pertence à empresa atual.' });
  }

  const initialQty = Number(currentQty) || 0;
  const minimumQty = Number(minQty) || 0;
  const status = getEPIStatus(initialQty, minimumQty);

  try {
    let autoCode = code;
    if (!autoCode) {
      let suffix = 1;
      let isUnique = false;
      while (!isUnique) {
        const generated = `EPI-${suffix.toString().padStart(3, '0')}`;
        const existing = await prisma.ePI.findFirst({
          where: { code: generated, companyId: actor.companyId },
          select: { id: true },
        });
        if (!existing) {
          autoCode = generated;
          isUnique = true;
        } else {
          suffix++;
        }
      }
    }

    const newEpi = await prisma.ePI.create({
      data: {
        code: autoCode,
        name,
        category,
        unit,
        currentQty: initialQty,
        minQty: minimumQty,
        location: location || 'Armazém Central',
        manufacturer: manufacturer || null,
        notes: notes || null,
        status: mapEPIStatusToDb(status),
        businessUnitId: businessUnitId || null,
        companyId: actor.companyId,
      },
    });

    const mappedEpi = mapPrismaEPI(newEpi);
    await addAuditLog(actor.id, actor.name, actor.role, 'Cadastro de Novo EPI', `Cadastrado EPI ${newEpi.name} (${newEpi.code}) com estoque inicial de ${initialQty} ${newEpi.unit}.`, 'epi');

    if (status !== 'normal') await triggerEmailNotification(mappedEpi, initialQty + 1, actor.companyId);
    return res.status(201).json(mappedEpi);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'Já existe um EPI com este código na empresa.' });
    console.error('Erro ao criar EPI:', err);
    return res.status(500).json({ error: 'Erro ao criar EPI no banco.' });
  }
});

app.put('/api/epis/:id', async (req, res) => {
  const { id } = req.params;
  const { code, name, category, unit, currentQty, minQty, location, manufacturer, notes, businessUnitId } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'epis', 'edit')) return;

  try {
    const existing = await prisma.ePI.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'EPI não encontrado.' });

    if (businessUnitId) {
      const unit = await prisma.businessUnit.findFirst({
        where: { id: businessUnitId, companyId: actor.companyId },
        select: { id: true },
      });
      if (!unit) return res.status(400).json({ error: 'A unidade selecionada não pertence à empresa atual.' });
    }

    const previousQty = existing.currentQty;
    const newCurrentQty = currentQty !== undefined ? Number(currentQty) : existing.currentQty;
    const newMinQty = minQty !== undefined ? Number(minQty) : existing.minQty;
    const newStatus = getEPIStatus(newCurrentQty, newMinQty);

    const updated = await prisma.ePI.update({
      where: { id },
      data: {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(unit !== undefined && { unit }),
        currentQty: newCurrentQty,
        minQty: newMinQty,
        ...(location !== undefined && { location }),
        ...(manufacturer !== undefined && { manufacturer }),
        ...(notes !== undefined && { notes }),
        status: mapEPIStatusToDb(newStatus),
        ...(businessUnitId !== undefined && { businessUnitId: businessUnitId === '' ? null : businessUnitId }),
      },
    });

    const mappedEpi = mapPrismaEPI(updated);
    await addAuditLog(actor.id, actor.name, actor.role, 'Edição de EPI', `Alteradas configurações do EPI ${updated.name} (${updated.code}). Mínimo: ${updated.minQty}, Qtd: ${updated.currentQty}.`, 'epi');
    if (newStatus !== 'normal') await triggerEmailNotification(mappedEpi, previousQty, actor.companyId);
    return res.json(mappedEpi);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'EPI não encontrado.' });
    console.error('Erro ao atualizar EPI:', err);
    return res.status(500).json({ error: 'Erro ao atualizar EPI no banco.' });
  }
});

app.delete('/api/epis/:id', async (req, res) => {
  const { id } = req.params;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'epis', 'delete')) return;

  try {
    const existing = await prisma.ePI.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'EPI não encontrado.' });
    const deleted = await prisma.ePI.delete({ where: { id: existing.id } });
    await addAuditLog(actor.id, actor.name, actor.role, 'Exclusão de EPI', `Excluído o item ${deleted.name} (${deleted.code}) do catálogo.`, 'epi');
    return res.json({ success: true, message: 'EPI excluído com sucesso.' });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'EPI não encontrado.' });
    return res.status(500).json({ error: 'Erro ao excluir EPI do banco.' });
  }
});

// =================== MATÉRIAS-PRIMAS ===================

const formulaStorageLocations = new Set([
  ...Array.from({ length: 7 }, (_, index) => `ARM ${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 7 }, (_, index) => `CX ${String(index + 1).padStart(2, '0')}`),
]);

function mapPrismaFormulaLot(lot: any) {
  return {
    id: lot.id,
    formulaId: lot.formulaId,
    batchCode: lot.batchCode,
    quantity: lot.quantity,
    entryDate: lot.entryDate instanceof Date ? lot.entryDate.toISOString() : lot.entryDate,
    supplier: lot.supplier ?? undefined,
    manufactureDate: lot.manufactureDate instanceof Date ? lot.manufactureDate.toISOString() : lot.manufactureDate ?? undefined,
    expirationDate: lot.expirationDate instanceof Date ? lot.expirationDate.toISOString() : lot.expirationDate ?? undefined,
    unitCost: lot.unitCost === null ? undefined : Number(lot.unitCost),
    createdAt: lot.createdAt instanceof Date ? lot.createdAt.toISOString() : lot.createdAt,
    updatedAt: lot.updatedAt instanceof Date ? lot.updatedAt.toISOString() : lot.updatedAt,
  };
}

function mapPrismaFormulaRetirada(item: any) {
  return {
    id: item.id,
    name: item.name,
    manufacturer: item.manufacturer ?? undefined,
    minQty: item.minQty,
    currentQty: item.currentQty,
    unit: item.unit ?? 'un',
    notes: item.notes ?? undefined,
    location: item.location,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt,
    lots: (item.lots ?? []).map(mapPrismaFormulaLot),
  };
}

function mapPrismaFormulaMovement(movement: any) {
  return {
    id: movement.id,
    formulaId: movement.formulaId,
    formulaName: movement.formulaName,
    type: movement.type,
    quantity: movement.quantity,
    lotId: movement.lotId ?? undefined,
    lotCode: movement.lotCode ?? undefined,
    supplier: movement.supplier ?? undefined,
    unitCost: movement.unitCost === null ? undefined : Number(movement.unitCost),
    countedQty: movement.countedQty ?? undefined,
    responsibleId: movement.responsibleId ?? undefined,
    responsibleName: movement.responsibleName,
    recipient: movement.recipient ?? undefined,
    reason: movement.reason ?? undefined,
    notes: movement.notes ?? undefined,
    date: movement.date instanceof Date ? movement.date.toISOString() : movement.date,
  };
}

function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? undefined : parsed;
}

async function getFormulaWithLots(tx: any, id: string) {
  return tx.formulaRetirada.findUnique({
    where: { id },
    include: { lots: { orderBy: [{ expirationDate: 'asc' }, { entryDate: 'asc' }] } },
  });
}

app.get('/api/formulas-retiradas', async (req, res) => {
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    const items = await prisma.formulaRetirada.findMany({
      where: { companyId: actor.companyId },
      orderBy: { name: 'asc' },
      include: { lots: { orderBy: [{ expirationDate: 'asc' }, { entryDate: 'asc' }] } },
    });
    return res.json(items.map(mapPrismaFormulaRetirada));
  } catch (err) {
    console.error('Erro ao buscar matérias-primas:', err);
    if (['P2021', 'P2022'].includes((err as any)?.code)) {
      return res.status(503).json({ error: 'O banco está desatualizado para o módulo de matérias-primas. Execute npm run db:migrate no backend.' });
    }
    return res.status(500).json({ error: 'Erro ao buscar matérias-primas do banco.' });
  }
});

app.post('/api/formulas-retiradas', async (req, res) => {
  const { name, manufacturer, minQty = 0, unit = 'un', notes, location } = req.body;
  const minimumQuantity = Number(minQty);
  if (!name?.trim() || !unit?.trim() || !formulaStorageLocations.has(location) || !Number.isInteger(minimumQuantity) || minimumQuantity < 0) {
    return res.status(400).json({ error: 'Informe nome, unidade de medida, estoque mínimo válido e um armazenamento entre ARM 01-07 ou CX 01-07.' });
  }
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'formulas', 'create')) return;

  try {
    const item = await prisma.formulaRetirada.create({
      data: { name: name.trim(), manufacturer: manufacturer?.trim() || null, minQty: minimumQuantity, currentQty: 0, unit: unit.trim(), notes: notes?.trim() || null, location, companyId: actor.companyId },
    });
    const created = await prisma.formulaRetirada.findUnique({ where: { id: item.id }, include: { lots: true } });
    await addAuditLog(actor.id, actor.name, actor.role, 'Cadastro de Matéria-prima', `Cadastrada a matéria-prima ${item.name}. Estoque mínimo: ${minimumQuantity} ${item.unit}.`, 'formula');
    return res.status(201).json(mapPrismaFormulaRetirada(created));
  } catch (err) {
    console.error('Erro ao criar matéria-prima:', err);
    if ((err as any)?.code === 'P2021') return res.status(503).json({ error: 'A tabela de matérias-primas não existe no banco. Aplique a migration 20261014120000_create_formula_retirada.' });
    return res.status(500).json({ error: 'Erro ao cadastrar matéria-prima no banco.' });
  }
});

app.put('/api/formulas-retiradas/:id', async (req, res) => {
  const { id } = req.params;
  const { name, manufacturer, minQty, unit, notes, location } = req.body;
  if ((name !== undefined && !name?.trim()) || (unit !== undefined && !unit?.trim()) || (location !== undefined && !formulaStorageLocations.has(location)) ||
      (minQty !== undefined && (!Number.isInteger(Number(minQty)) || Number(minQty) < 0)) || req.body.currentQty !== undefined) {
    return res.status(400).json({ error: 'Dados inválidos. Estoque atual deve ser alterado por lote; verifique nome, estoque mínimo e armazenamento.' });
  }
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'formulas', 'edit')) return;

  try {
    const existing = await prisma.formulaRetirada.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'Matéria-prima não encontrada.' });
    const item = await prisma.formulaRetirada.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(manufacturer !== undefined && { manufacturer: manufacturer?.trim() || null }),
        ...(minQty !== undefined && { minQty: Number(minQty) }),
        ...(unit !== undefined && { unit: unit.trim() }),
        ...(notes !== undefined && { notes: notes?.trim() || null }),
        ...(location !== undefined && { location }),
      },
    });
    const updated = await prisma.formulaRetirada.findUnique({ where: { id: item.id }, include: { lots: true } });
    await addAuditLog(actor.id, actor.name, actor.role, 'Edição de Matéria-prima', `Alterada a matéria-prima ${item.name}. Estoque mínimo: ${item.minQty}.`, 'formula');
    return res.json(mapPrismaFormulaRetirada(updated));
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Matéria-prima não encontrada.' });
    if (err?.code === 'P2021') return res.status(503).json({ error: 'A tabela de matérias-primas não existe no banco. Aplique a migration 20261014120000_create_formula_retirada.' });
    console.error('Erro ao atualizar matéria-prima:', err);
    return res.status(500).json({ error: 'Erro ao atualizar matéria-prima no banco.' });
  }
});

app.delete('/api/formulas-retiradas/:id', async (req, res) => {
  const { id } = req.params;
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor || !requirePermission(actor, res, 'formulas', 'delete')) return;

  try {
    const existing = await prisma.formulaRetirada.findFirst({ where: { id, companyId: actor.companyId } });
    if (!existing) return res.status(404).json({ error: 'Matéria-prima não encontrada.' });
    const item = await prisma.formulaRetirada.delete({ where: { id: existing.id } });
    await addAuditLog(actor.id, actor.name, actor.role, 'Exclusão de Matéria-prima', `Excluída a matéria-prima ${item.name}.`, 'formula');
    return res.json({ success: true, message: 'Matéria-prima excluída com sucesso.' });
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'Matéria-prima não encontrada.' });
    if (err?.code === 'P2021') return res.status(503).json({ error: 'A tabela de matérias-primas não existe no banco. Aplique a migration 20261014120000_create_formula_retirada.' });
    if (err?.code === 'P2003') return res.status(409).json({ error: 'Não é possível excluir uma matéria-prima que possui movimentações no histórico.' });
    console.error('Erro ao excluir matéria-prima:', err);
    return res.status(500).json({ error: 'Erro ao excluir matéria-prima do banco.' });
  }
});

app.get('/api/formulas-retiradas/movements', async (req, res) => {
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    const movements = await prisma.formulaMovement.findMany({
      where: { companyId: actor.companyId },
      orderBy: { date: 'desc' },
    });
    return res.json(movements.map(mapPrismaFormulaMovement));
  } catch (err) {
    console.error('Erro ao buscar movimentações de matérias-primas:', err);
    if (['P2021', 'P2022'].includes((err as any)?.code)) {
      return res.status(503).json({ error: 'O banco está desatualizado para o histórico de matérias-primas. Execute npm run db:migrate no backend.' });
    }
    return res.status(500).json({ error: 'Erro ao buscar movimentações de matérias-primas.' });
  }
});

app.post('/api/formulas-retiradas/movements', async (req, res) => {
  const {
    formulaId, type, quantity, countedQty, lotId, batchCode, supplier, unitCost,
    entryDate, manufactureDate, expirationDate, responsibleId, responsibleName,
    responsibleRole, reason, recipient, notes,
  } = req.body;
  const numQty = Number(quantity);
  const adjustmentTypes = ['ajuste_sobra', 'ajuste_perda', 'ajuste_avaria', 'ajuste_correcao', 'contagem'];
  const isAdjustment = adjustmentTypes.includes(type);
  const parsedEntryDate = parseOptionalDate(entryDate);
  const parsedManufactureDate = parseOptionalDate(manufactureDate);
  const parsedExpirationDate = parseOptionalDate(expirationDate);
  const parsedUnitCost = unitCost === undefined || unitCost === '' ? null : Number(unitCost);

  if (!formulaId || (!['entrada', 'saida'].includes(type) && !isAdjustment)) {
    return res.status(400).json({ error: 'Matéria-prima e tipo de movimentação válidos são obrigatórios.' });
  }
  if (type === 'entrada' && (!Number.isInteger(numQty) || numQty <= 0 || !batchCode?.trim())) {
    return res.status(400).json({ error: 'Informe uma quantidade positiva e o número do lote para registrar a entrada.' });
  }
  if (type === 'saida' && (!Number.isInteger(numQty) || numQty <= 0)) {
    return res.status(400).json({ error: 'A quantidade de retirada deve ser um número inteiro maior que zero.' });
  }
  if (isAdjustment && (
    !lotId || !Number.isInteger(Number(countedQty)) || Number(countedQty) < 0 ||
    !reason?.trim() || !responsibleName?.trim()
  )) {
    return res.status(400).json({ error: 'Ajustes exigem lote, contagem física, justificativa e responsável.' });
  }
  if (type === 'entrada' && (parsedEntryDate === undefined || parsedManufactureDate === undefined || parsedExpirationDate === undefined)) {
    return res.status(400).json({ error: 'Informe datas válidas para entrada, fabricação e validade.' });
  }
  if (parsedManufactureDate && parsedExpirationDate && parsedManufactureDate > parsedExpirationDate) {
    return res.status(400).json({ error: 'A fabricação não pode ocorrer depois da data de validade.' });
  }
  if (parsedUnitCost !== null && (!Number.isFinite(parsedUnitCost) || parsedUnitCost < 0)) {
    return res.status(400).json({ error: 'O custo unitário deve ser um valor válido e não negativo.' });
  }
  if (!useDatabase || !prisma) return res.status(503).json({ error: 'Banco de dados não configurado.' });

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const lockedFormula = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "FormulaRetirada"
        WHERE "id" = ${formulaId} AND "companyId" = ${actor.companyId}
        FOR UPDATE
      `;
      if (!lockedFormula.length) return { error: 'Matéria-prima não encontrada.' };

      const formula = await tx.formulaRetirada.findUniqueOrThrow({ where: { id: formulaId } });
      const movements = [];

      if (type === 'entrada') {
        const normalizedBatchCode = batchCode.trim();
        if (/^LEGACY-/i.test(normalizedBatchCode)) {
          return { error: 'O prefixo LEGACY- é reservado para saldos migrados.' };
        }

        const existingLot = await tx.formulaLot.findUnique({
          where: { formulaId_batchCode: { formulaId, batchCode: normalizedBatchCode } },
        });
        if (existingLot && (
          (parsedExpirationDate?.toISOString() ?? null) !== (existingLot.expirationDate?.toISOString() ?? null) ||
          (parsedManufactureDate?.toISOString() ?? null) !== (existingLot.manufactureDate?.toISOString() ?? null)
        )) {
          return { error: 'Este código de lote já existe com datas de fabricação ou validade diferentes.' };
        }

        const lot = existingLot
          ? await tx.formulaLot.update({
              where: { id: existingLot.id },
              data: {
                quantity: { increment: numQty },
                ...(supplier?.trim() && { supplier: supplier.trim() }),
                ...(parsedUnitCost !== null && { unitCost: parsedUnitCost }),
              },
            })
          : await tx.formulaLot.create({
              data: {
                formulaId,
                batchCode: normalizedBatchCode,
                quantity: numQty,
                entryDate: parsedEntryDate ?? new Date(),
                supplier: supplier?.trim() || null,
                manufactureDate: parsedManufactureDate ?? null,
                expirationDate: parsedExpirationDate ?? null,
                unitCost: parsedUnitCost,
              },
            });

        await tx.formulaRetirada.update({
          where: { id: formulaId },
          data: { currentQty: { increment: numQty } },
        });
        movements.push(await tx.formulaMovement.create({
          data: {
            formulaId, formulaName: formula.name, type, quantity: numQty,
            lotId: lot.id, lotCode: lot.batchCode, supplier: supplier?.trim() || lot.supplier,
            unitCost: parsedUnitCost ?? lot.unitCost,
            companyId: actor.companyId,
            responsibleId: responsibleId || null,
            responsibleName: responsibleName || 'Operador do Sistema',
            reason: reason?.trim() || 'Entrada de lote',
            recipient: recipient || null, notes: notes || null,
          },
        }));
      } else if (type === 'saida') {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const lots = await tx.formulaLot.findMany({
          where: {
            formulaId,
            quantity: { gt: 0 },
            OR: [{ expirationDate: null }, { expirationDate: { gte: today } }],
          },
          orderBy: [{ expirationDate: { sort: 'asc', nulls: 'last' } }, { entryDate: 'asc' }],
        });
        const availableQty = lots.reduce((sum: number, lot: any) => sum + lot.quantity, 0);
        if (availableQty < numQty) {
          const totalQty = await tx.formulaLot.aggregate({ where: { formulaId }, _sum: { quantity: true } });
          const totalStock = totalQty._sum.quantity ?? 0;
          return {
            error: totalStock - availableQty > 0
              ? `Há ${totalStock - availableQty} unidade(s) vencida(s); o sistema bloqueia a retirada de lotes vencidos.`
              : `Estoque disponível insuficiente de ${formula.name}: ${availableQty} ${formula.unit}.`,
          };
        }

        let remaining = numQty;
        for (const lot of lots) {
          if (!remaining) break;
          const taken = Math.min(remaining, lot.quantity);
          const updated = await tx.formulaLot.updateMany({
            where: { id: lot.id, quantity: { gte: taken } },
            data: { quantity: { decrement: taken } },
          });
          if (!updated.count) throw new Error('O lote foi alterado por outra movimentação. Tente novamente.');
          movements.push(await tx.formulaMovement.create({
            data: {
              formulaId, formulaName: formula.name, type, quantity: taken,
              lotId: lot.id, lotCode: lot.batchCode, supplier: lot.supplier, unitCost: lot.unitCost,
              companyId: actor.companyId,
              responsibleId: responsibleId || null,
              responsibleName: responsibleName || 'Operador do Sistema',
              reason: reason?.trim() || 'Retirada de matéria-prima',
              recipient: recipient || null, notes: notes || null,
            },
          }));
          remaining -= taken;
        }
        await tx.formulaRetirada.update({
          where: { id: formulaId },
          data: { currentQty: { decrement: numQty } },
        });
      } else {
        const lot = await tx.formulaLot.findFirst({ where: { id: lotId, formulaId } });
        if (!lot) return { error: 'Lote da matéria-prima não encontrado.' };
        const physicalQty = Number(countedQty);
        const difference = physicalQty - lot.quantity;
        if (!difference && type !== 'contagem') return { error: 'A contagem física é igual ao saldo do lote; use a operação Contagem sem ajuste para registrar a conferência.' };
        if (difference && type === 'contagem') return { error: 'A contagem difere do saldo; selecione sobra, perda, avaria ou correção para ajustar o estoque.' };
        if (type === 'ajuste_sobra' && difference < 0) return { error: 'O ajuste de sobra exige contagem acima do saldo do lote.' };
        if (['ajuste_perda', 'ajuste_avaria'].includes(type) && difference > 0) return { error: 'Perdas e avarias exigem contagem abaixo do saldo do lote.' };

        await tx.formulaLot.update({ where: { id: lot.id }, data: { quantity: physicalQty } });
        await tx.formulaRetirada.update({
          where: { id: formulaId },
          data: { currentQty: { increment: difference } },
        });
        movements.push(await tx.formulaMovement.create({
          data: {
            formulaId, formulaName: formula.name, type, quantity: Math.abs(difference),
            lotId: lot.id, lotCode: lot.batchCode, supplier: lot.supplier, unitCost: lot.unitCost,
            companyId: actor.companyId,
            countedQty: physicalQty, responsibleId: responsibleId || null,
            responsibleName: responsibleName.trim(), reason: reason.trim(), notes: notes || null,
          },
        }));
      }

      const updatedFormula = await getFormulaWithLots(tx, formulaId);
      return { formula: updatedFormula, movements };
    });

    if ('error' in result) {
      return res.status(result.error === 'Matéria-prima não encontrada.' ? 404 : 400).json({ error: result.error });
    }

    const action = type === 'entrada' ? 'Entrada de Matéria-prima'
      : type === 'saida' ? 'Retirada de Matéria-prima'
      : type === 'contagem' ? 'Contagem física de Matéria-prima'
      : `Ajuste de estoque (${type.replace('ajuste_', '')})`;
    await addAuditLog(
      actor.id, actor.name, actor.role, action,
      `${type.toUpperCase()}: ${result.movements.reduce((sum: number, movement: any) => sum + movement.quantity, 0)} ${result.formula.unit} de ${result.formula.name}; saldo atualizado para ${result.formula.currentQty}.`,
      'formula',
    );

    return res.status(201).json({
      movement: mapPrismaFormulaMovement(result.movements[0]),
      movements: result.movements.map(mapPrismaFormulaMovement),
      updatedFormula: mapPrismaFormulaRetirada(result.formula),
    });
  } catch (err) {
    console.error('Erro ao criar movimentação de matéria-prima:', err);
    return res.status(500).json({ error: 'Erro ao registrar movimentação de matéria-prima.' });
  }
});

// =================== MOVEMENTS ===================

app.get('/api/movements', async (_req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(_req, res);
  if (!actor) return;

  try {
    const dbMovements = await prisma.movement.findMany({
      where: { companyId: actor.companyId },
      orderBy: { date: 'desc' },
    });
    return res.json(dbMovements.map(mapPrismaMovement));
  } catch (err) {
    console.error('Erro ao buscar movimentos:', err);
    return res.status(500).json({ error: 'Erro ao buscar movimentos do banco.' });
  }
});

app.post('/api/movements', async (req, res) => {
  const { epiId, type, quantity, responsibleId, responsibleName, reason, recipient, notes, businessUnitId } = req.body;
  if (!epiId || !type || !quantity || quantity <= 0) return res.status(400).json({ error: 'Produto, tipo de movimentação e quantidade válida são obrigatórios.' });

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const numQty = Number(quantity);

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    const epiDb = await prisma.ePI.findFirst({ where: { id: epiId, companyId: actor.companyId } });
    if (!epiDb) return res.status(404).json({ error: 'EPI selecionado não existe no sistema.' });

    if (type === 'saida' && epiDb.currentQty < numQty) {
      return res.status(400).json({ error: `Estoque insuficiente! Saldo atual de ${epiDb.name}: ${epiDb.currentQty} ${epiDb.unit}. Tentativa de saída: ${numQty} ${epiDb.unit}.` });
    }

    const previousQty = epiDb.currentQty;
    const newQty = type === 'entrada' ? epiDb.currentQty + numQty : epiDb.currentQty - numQty;
    const newStatus = getEPIStatus(newQty, epiDb.minQty);

    const [newMovement, updatedEpi] = await prisma.$transaction([
      prisma.movement.create({
        data: {
          epiId: epiDb.id,
          epiCode: epiDb.code,
          epiName: epiDb.name,
          type,
          quantity: numQty,
          responsibleId: responsibleId || null,
          responsibleName: responsibleName || 'Operador do Sistema',
          reason: reason || (type === 'entrada' ? 'Reposição de Estoque' : 'Entrega para Setor'),
          recipient: recipient || (type === 'entrada' ? 'Almoxarifado' : 'Equipe Operacional'),
          notes: notes || null,
          businessUnitId: businessUnitId || null,
          companyId: actor.companyId,
        },
      }),
      prisma.ePI.update({
        where: { id: epiId },
        data: {
          currentQty: newQty,
          status: mapEPIStatusToDb(newStatus),
        },
      }),
    ]);

    const mappedMovement = mapPrismaMovement(newMovement);
    const mappedEpi = mapPrismaEPI(updatedEpi);

    const actionText = type === 'entrada' ? 'Entrada de Estoque' : 'Saída de Estoque';
    const detailText = `${type.toUpperCase()}: ${numQty} ${updatedEpi.unit} de ${updatedEpi.name} (${updatedEpi.code}). Saldo atualizado para: ${newQty} ${updatedEpi.unit}.`;
    await addAuditLog(actor.id, actor.name, actor.role, actionText, detailText, 'epi');

    await triggerEmailNotification(mappedEpi, previousQty, actor.companyId);

    return res.status(201).json({ movement: mappedMovement, updatedEpi: mappedEpi });
  } catch (err) {
    console.error('Erro ao criar movimento:', err);
    return res.status(500).json({ error: 'Erro ao registrar movimentação no banco.' });
  }
});

// =================== NOTIFICATIONS ===================

app.get('/api/notifications', async (req, res) => {
  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    const dbNotifs = await prisma.notification.findMany({
      where: { companyId: actor.companyId },
      orderBy: { timestamp: 'desc' },
    });
    return res.json(dbNotifs.map(mapPrismaNotification));
  } catch (err) {
    console.error('Erro ao buscar notificações:', err);
    return res.status(500).json({ error: 'Erro ao buscar notificações do banco.' });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { id } = req.body;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;

  try {
    if (id) {
      const notification = await prisma.notification.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true } });
      if (!notification) return res.status(404).json({ error: 'Notificação não encontrada.' });
      await prisma.notification.update({ where: { id: notification.id }, data: { read: true } });
    } else {
      await prisma.notification.updateMany({ where: { companyId: actor.companyId }, data: { read: true } });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Erro ao marcar notificação como lida:', err);
    return res.status(500).json({ error: 'Erro ao atualizar notificação.' });
  }
});

// =================== AUDIT LOGS ===================

app.get('/api/logs', async (req, res) => {
  const module = req.query.module;
  if (!['system', 'epi', 'formula'].includes(String(module))) {
    return res.status(400).json({ error: 'Informe um módulo de auditoria válido.' });
  }

  const actor = await resolvePackagingActor(req, res);
  if (!actor) return;
  const auditAccessModule = module === 'system' ? 'system-audit' : module === 'formula' ? 'formula-audit' : 'epi-audit';
  if (!requirePermission(actor, res, auditAccessModule, 'view')) return;

  if (!useDatabase || !prisma) {
    return res.status(503).json({ error: 'Banco de dados não configurado.' });
  }

  try {
    const dbLogs = await prisma.auditLog.findMany({
      where: { companyId: actor.companyId, module: String(module) },
      orderBy: { timestamp: 'desc' },
    });
    return res.json(dbLogs.map(mapPrismaLog));
  } catch (err) {
    console.error('Erro ao buscar logs:', err);
    return res.status(500).json({ error: 'Erro ao buscar logs do banco.' });
  }
});

// =================== VITE SERVER ===================

async function startServer() {
  await ensureInitialMaster();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: path.resolve(__dirname, '../frontend'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, '../dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API Status: http://localhost:${PORT}/api/database-status`);
    console.log(`🗄️  Database: ${useDatabase ? 'PostgreSQL (Supabase)' : 'In-Memory (Modo Demo)'}\n`);
  });
}

if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Erro ao iniciar o servidor:', err);
    process.exitCode = 1;
  });
}

export default app;
