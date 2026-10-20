import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados FormulaEPI...');

  // Limpar dados existentes na ordem correta (respeitar foreign keys)
  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.movement.deleteMany();
  await prisma.ePI.deleteMany();
  await prisma.user.deleteMany({ where: { role: { not: 'master' } } });
  await prisma.businessUnit.deleteMany();

  console.log('🗑️  Dados anteriores removidos.');
  const company = await prisma.company.findFirst() ?? await prisma.company.create({
    data: { id: 'company-demo', name: 'FarmaFlow', updatedAt: new Date() },
  });

  // ===================== UNIDADES =====================
  const businessUnits = await prisma.$transaction([
    prisma.businessUnit.create({
      data: {
        id: 'bu-matriz',
        name: 'Matriz São Paulo',
        code: 'MAT',
        type: 'matriz',
        address: 'Rua das Palmeiras, 100 - São Paulo/SP',
        active: true,
        companyId: company.id,
      },
    }),
    prisma.businessUnit.create({
      data: {
        id: 'bu-filial',
        name: 'Filial Campinas',
        code: 'FIL',
        type: 'filial',
        address: 'Av. Industrial, 250 - Campinas/SP',
        active: true,
        companyId: company.id,
      },
    }),
  ]);
  console.log(`✅ ${businessUnits.length} unidades criadas.`);

  // ===================== USUÁRIOS =====================
  const users = await prisma.$transaction([
    prisma.user.create({
      data: {
        id: 'u-admin-1',
        name: 'Carlos Andrade (Administrador)',
        email: 'admin@epi.com',
        password: 'demo123',
        role: 'admin',
        status: 'active',
        department: 'Segurança do Trabalho (SESMT)',
        businessUnitId: 'bu-matriz',
        companyId: company.id,
        createdAt: new Date('2026-01-10T08:00:00.000Z'),
        lastLogin: new Date('2026-08-05T08:30:00.000Z'),
      },
    }),
    prisma.user.create({
      data: {
        id: 'u-operador-1',
        name: 'Mariana Costa (Operadora)',
        email: 'operador@epi.com',
        password: 'demo123',
        role: 'operador',
        status: 'active',
        department: 'Almoxarifado Principal',
        businessUnitId: 'bu-filial',
        companyId: company.id,
        createdAt: new Date('2026-02-15T09:30:00.000Z'),
        lastLogin: new Date('2026-08-05T07:45:00.000Z'),
      },
    }),
    prisma.user.create({
      data: {
        id: 'u-visualizador-1',
        name: 'Roberto Lima (Auditor Visualizador)',
        email: 'visualizador@epi.com',
        password: 'demo123',
        role: 'visualizador',
        status: 'active',
        department: 'Gestão de Qualidade',
        businessUnitId: 'bu-matriz',
        companyId: company.id,
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
        lastLogin: new Date('2026-08-04T16:20:00.000Z'),
      },
    }),
  ]);
  console.log(`✅ ${users.length} usuários criados.`);

  // ===================== EPIs =====================
  const episData = [
    {
      id: 'epi-01',
      code: 'EPI-001',
      name: 'Luva de Nitrila Verde Tam G',
      category: 'Proteção das Mãos',
      unit: 'Par',
      currentQty: 180,
      minQty: 50,
      location: 'Corredor A - Prateleira 01',
      manufacturer: 'Volk do Brasil',
      notes: 'Resistente a produtos químicos e solventes. Uso geral em laboratório.',
      status: 'normal',
      businessUnitId: 'bu-matriz',
    },
    {
      id: 'epi-02',
      code: 'EPI-002',
      name: 'Máscara Cirúrgica Descartável c/ Elástico',
      category: 'Proteção Respiratória',
      unit: 'Caixa c/ 50',
      currentQty: 8,
      minQty: 15,
      location: 'Corredor B - Prateleira 03',
      manufacturer: 'Descarpack',
      notes: 'Tripla camada com filtro bacteriológico (BFE >= 95%).',
      status: 'baixo',
      businessUnitId: 'bu-filial',
    },
    {
      id: 'epi-03',
      code: 'EPI-003',
      name: 'Máscara PFF2 N95 sem Válvula',
      category: 'Proteção Respiratória',
      unit: 'Unidade',
      currentQty: 0,
      minQty: 40,
      location: 'Corredor B - Prateleira 02',
      manufacturer: '3M do Brasil',
      notes: 'Ajuste nasal com presilha metálica. Filtro eletrostático.',
      status: 'esgotado',
      businessUnitId: 'bu-filial',
    },
    {
      id: 'epi-04',
      code: 'EPI-004',
      name: 'Propé Descartável TNT c/ Elástico',
      category: 'Vestuário',
      unit: 'Pacote c/ 100',
      currentQty: 25,
      minQty: 10,
      location: 'Corredor C - Prateleira 01',
      manufacturer: 'Anhembi Hospitalar',
      notes: 'Proteção para calçados em áreas limpas e cirúrgicas.',
      status: 'normal',
    },
    {
      id: 'epi-05',
      code: 'EPI-005',
      name: 'Touca Descartável Sanfonada Branca',
      category: 'Vestuário',
      unit: 'Pacote c/ 100',
      currentQty: 4,
      minQty: 12,
      location: 'Corredor C - Prateleira 02',
      manufacturer: 'Spunbond',
      notes: 'Gramatura 20g/m². Uso industrial e farmacêutico.',
      status: 'baixo',
    },
    {
      id: 'epi-06',
      code: 'EPI-006',
      name: 'Jaleco Descartável Manga Longa Gramatura 40',
      category: 'Vestuário',
      unit: 'Unidade',
      currentQty: 60,
      minQty: 20,
      location: 'Corredor C - Prateleira 04',
      manufacturer: 'Kappes',
      notes: 'Fechamento por zíper e punho com elástico.',
      status: 'normal',
    },
    {
      id: 'epi-07',
      code: 'EPI-007',
      name: 'Avental Impermeável de PVC Amarelo 1,20m',
      category: 'Vestuário',
      unit: 'Unidade',
      currentQty: 15,
      minQty: 8,
      location: 'Corredor D - Prateleira 01',
      manufacturer: 'Plasticos Vipal',
      notes: 'Ideal para higienização e lavagem de instrumental.',
      status: 'normal',
    },
    {
      id: 'epi-08',
      code: 'EPI-008',
      name: 'Óculos de Proteção Incolor Anti-risco e Anti-embaçante',
      category: 'Proteção Ocular',
      unit: 'Unidade',
      currentQty: 3,
      minQty: 15,
      location: 'Corredor A - Prateleira 04',
      manufacturer: 'Kalipso Safety',
      notes: 'Proteção contra impactos de partículas e raios UV.',
      status: 'baixo',
    },
    {
      id: 'epi-09',
      code: 'EPI-009',
      name: 'Capacete de Segurança Aba Frontal Classe B com Jugular',
      category: 'Proteção da Cabeça',
      unit: 'Unidade',
      currentQty: 0,
      minQty: 10,
      location: 'Corredor E - Prateleira 01',
      manufacturer: 'MSA Safety',
      notes: 'Suspensão com catraca de fácil ajuste. Proteção dielétrica.',
      status: 'esgotado',
    },
    {
      id: 'epi-10',
      code: 'EPI-010',
      name: 'Protetor Auricular de Inserção de Silicone c/ Cordão',
      category: 'Proteção Auditiva',
      unit: 'Par',
      currentQty: 120,
      minQty: 30,
      location: 'Corredor A - Prateleira 02',
      manufacturer: '3M Pompeia',
      notes: 'Atenuação NRRsf 18dB. Lavável e reutilizável.',
      status: 'normal',
    },
    {
      id: 'epi-11',
      code: 'EPI-011',
      name: 'Botina de Segurança de Amarrar Couro Nobuck Café',
      category: 'Proteção dos Pés',
      unit: 'Par',
      currentQty: 18,
      minQty: 10,
      location: 'Depósito Inferior - Box 02',
      manufacturer: 'Brametal Soft',
      notes: 'Biqueira de PVC, solado em poliuretano bidensidade.',
      status: 'normal',
    },
    {
      id: 'epi-12',
      code: 'EPI-012',
      name: 'Cinto de Segurança Tipo Paraquedista 4 Pontos',
      category: 'Acessórios e Outros',
      unit: 'Unidade',
      currentQty: 12,
      minQty: 5,
      location: 'Corredor E - Prateleira 03',
      manufacturer: 'Hércules',
      notes: 'Possui elemento de engate dorsal e peitoral para trabalho em altura.',
      status: 'normal',
    },
  ];

  for (const epi of episData) {
    await prisma.ePI.create({ data: { ...epi, companyId: company.id } });
  }
  console.log(`✅ ${episData.length} EPIs criados.`);

  // ===================== MOVIMENTAÇÕES =====================
  const movements = await prisma.$transaction([
    prisma.movement.create({
      data: {
        id: 'mov-101',
        epiId: 'epi-03',
        epiCode: 'EPI-003',
        epiName: 'Máscara PFF2 N95 sem Válvula',
        type: 'saida',
        quantity: 15,
        responsibleId: 'u-operador-1',
        responsibleName: 'Mariana Costa (Operadora)',
        reason: 'Entrega para equipe de Manutenção de Dutos',
        recipient: 'Marcos Vinícius - Setor Manutenção',
        date: new Date('2026-08-05T07:00:00.000Z'),
        notes: 'Produto ficou com estoque esgotado!',
        businessUnitId: 'bu-filial',
        companyId: company.id,
      },
    }),
    prisma.movement.create({
      data: {
        id: 'mov-102',
        epiId: 'epi-08',
        epiCode: 'EPI-008',
        epiName: 'Óculos de Proteção Incolor Anti-risco e Anti-embaçante',
        type: 'saida',
        quantity: 12,
        responsibleId: 'u-operador-1',
        responsibleName: 'Mariana Costa (Operadora)',
        reason: 'Distribuição periódica a novos contratados',
        recipient: 'Juliana Paes - RH Treinamento',
        date: new Date('2026-08-05T07:20:00.000Z'),
        notes: 'Estoque atingiu nível crítico (3 un < min 15 un).',
        businessUnitId: 'bu-matriz',
        companyId: company.id,
      },
    }),
    prisma.movement.create({
      data: {
        id: 'mov-103',
        epiId: 'epi-02',
        epiCode: 'EPI-002',
        epiName: 'Máscara Cirúrgica Descartável c/ Elástico',
        type: 'saida',
        quantity: 10,
        responsibleId: 'u-operador-1',
        responsibleName: 'Mariana Costa (Operadora)',
        reason: 'Solicitação do Ambulatório Médico',
        recipient: 'Dra. Fernanda Siqueira - Ambulatório',
        date: new Date('2026-08-05T06:10:00.000Z'),
        notes: 'Alerta emitido por e-mail.',
        businessUnitId: 'bu-filial',
        companyId: company.id,
      },
    }),
    prisma.movement.create({
      data: {
        id: 'mov-104',
        epiId: 'epi-01',
        epiCode: 'EPI-001',
        epiName: 'Luva de Nitrila Verde Tam G',
        type: 'entrada',
        quantity: 100,
        responsibleId: 'u-admin-1',
        responsibleName: 'Carlos Andrade (Administrador)',
        reason: 'Nota Fiscal de Compra nº 48921',
        recipient: 'Almoxarifado Principal',
        date: new Date('2026-08-04T14:30:00.000Z'),
        notes: 'Recebimento de lote do fornecedor Volk.',
        businessUnitId: 'bu-matriz',
        companyId: company.id,
      },
    }),
    prisma.movement.create({
      data: {
        id: 'mov-105',
        epiId: 'epi-09',
        epiCode: 'EPI-009',
        epiName: 'Capacete de Segurança Aba Frontal Classe B com Jugular',
        type: 'saida',
        quantity: 10,
        responsibleId: 'u-operador-1',
        responsibleName: 'Mariana Costa (Operadora)',
        reason: 'Entrega para turma de Obras de Expansão',
        recipient: 'Eng. Fernando Diniz - Obras',
        date: new Date('2026-08-05T07:12:00.000Z'),
        notes: 'Item totalmente esgotado.',
        businessUnitId: 'bu-matriz',
        companyId: company.id,
      },
    }),
    prisma.movement.create({
      data: {
        id: 'mov-106',
        epiId: 'epi-10',
        epiCode: 'EPI-010',
        epiName: 'Protetor Auricular de Inserção de Silicone c/ Cordão',
        type: 'entrada',
        quantity: 50,
        responsibleId: 'u-admin-1',
        responsibleName: 'Carlos Andrade (Administrador)',
        reason: 'Reposição quinzenal agendada',
        recipient: 'Almoxarifado Central',
        businessUnitId: 'bu-matriz',
        date: new Date('2026-08-04T16:00:00.000Z'),
        companyId: company.id,
      },
    }),
  ]);
  console.log(`✅ ${movements.length} movimentações criadas.`);

  // ===================== AUDIT LOGS =====================
  const logs = await prisma.$transaction([
    prisma.auditLog.create({
      data: {
        id: 'log-1',
        timestamp: new Date('2026-08-05T08:30:00.000Z'),
        userId: 'u-admin-1',
        userName: 'Carlos Andrade (Administrador)',
        userRole: 'admin',
        action: 'Login no Sistema',
        details: 'Usuário realizou login com sucesso via e-mail.',
        companyId: company.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        id: 'log-2',
        timestamp: new Date('2026-08-05T07:20:00.000Z'),
        userId: 'u-operador-1',
        userName: 'Mariana Costa (Operadora)',
        userRole: 'operador',
        action: 'Saída de Estoque',
        details: 'Registrada saída de 12 unidades do produto EPI-008 (Óculos de Proteção Incolor).',
        companyId: company.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        id: 'log-3',
        timestamp: new Date('2026-08-05T07:12:00.000Z'),
        userId: 'u-operador-1',
        userName: 'Mariana Costa (Operadora)',
        userRole: 'operador',
        action: 'Alerta de Esgotamento Disparado',
        details: 'Produto EPI-009 (Capacete de Segurança) ficou sem estoque (0 un). Notificação enviada.',
        companyId: company.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        id: 'log-4',
        timestamp: new Date('2026-08-05T07:00:00.000Z'),
        userId: 'u-operador-1',
        userName: 'Mariana Costa (Operadora)',
        userRole: 'operador',
        action: 'Saída de Estoque & Esgotamento',
        details: 'Registrada saída de 15 unidades de EPI-003 (Máscara PFF2). Produto atingiu 0 unidades.',
        companyId: company.id,
      },
    }),
    prisma.auditLog.create({
      data: {
        id: 'log-5',
        timestamp: new Date('2026-08-04T14:30:00.000Z'),
        userId: 'u-admin-1',
        userName: 'Carlos Andrade (Administrador)',
        userRole: 'admin',
        action: 'Entrada de Estoque',
        details: 'Registrada entrada de 100 unidades de EPI-001 (Luva de Nitrila Verde Tam G).',
        companyId: company.id,
      },
    }),
  ]);
  console.log(`✅ ${logs.length} logs de auditoria criados.`);

  // ===================== NOTIFICAÇÕES =====================
  const notifications = await prisma.$transaction([
    prisma.notification.create({
      data: {
        id: 'email-201',
        timestamp: new Date('2026-08-05T07:12:00.000Z'),
        recipient: 'admin@epi.com',
        subject: '🚨 URGENTE: Produto Esgotado - Capacete de Segurança Aba Frontal',
        body: 'Atenção Administrador,\n\nO produto abaixo ESGOTOU COMPLETAMENTE no estoque:\n\n• Produto: Capacete de Segurança Aba Frontal Classe B com Jugular (EPI-009)\n• Quantidade Atual: 0 Unidades\n• Quantidade Mínima Desejada: 10 Unidades\n• Localização: Corredor E - Prateleira 01',
        type: 'out_of_stock',
        read: false,
        epiId: 'epi-09',
        companyId: company.id,
      },
    }),
    prisma.notification.create({
      data: {
        id: 'email-202',
        timestamp: new Date('2026-08-05T07:00:00.000Z'),
        recipient: 'admin@epi.com',
        subject: '🚨 URGENTE: Produto Esgotado - Máscara PFF2 N95 sem Válvula',
        body: 'Atenção Administrador,\n\nO produto abaixo ESGOTOU COMPLETAMENTE no estoque:\n\n• Produto: Máscara PFF2 N95 sem Válvula (EPI-003)\n• Quantidade Atual: 0 Unidades\n• Quantidade Mínima Desejada: 40 Unidades\n• Localização: Corredor B - Prateleira 02',
        type: 'out_of_stock',
        read: false,
        epiId: 'epi-03',
        companyId: company.id,
      },
    }),
    prisma.notification.create({
      data: {
        id: 'email-203',
        timestamp: new Date('2026-08-05T07:20:00.000Z'),
        recipient: 'admin@epi.com',
        subject: '⚠️ ALERTA: Estoque Mínimo Atingido - Óculos de Proteção Incolor',
        body: 'Atenção Administrador,\n\nO produto abaixo atingiu ou ficou abaixo da quantidade mínima configurada:\n\n• Produto: Óculos de Proteção Incolor Anti-risco e Anti-embaçante (EPI-008)\n• Quantidade Atual: 3 Unidades\n• Quantidade Mínima: 15 Unidades\n• Localização: Corredor A - Prateleira 04',
        type: 'low_stock',
        read: false,
        epiId: 'epi-08',
        companyId: company.id,
      },
    }),
    prisma.notification.create({
      data: {
        id: 'email-204',
        timestamp: new Date('2026-08-05T06:10:00.000Z'),
        recipient: 'admin@epi.com',
        subject: '⚠️ ALERTA: Estoque Mínimo Atingido - Máscara Cirúrgica Descartável',
        body: 'Atenção Administrador,\n\nO produto abaixo atingiu ou ficou abaixo da quantidade mínima configurada:\n\n• Produto: Máscara Cirúrgica Descartável c/ Elástico (EPI-002)\n• Quantidade Atual: 8 Caixas c/ 50\n• Quantidade Mínima: 15 Caixas c/ 50\n• Localização: Corredor B - Prateleira 03',
        type: 'low_stock',
        read: true,
        epiId: 'epi-02',
        companyId: company.id,
      },
    }),
  ]);
  console.log(`✅ ${notifications.length} notificações criadas.`);

  console.log('\n🎉 Seed concluído com sucesso! Banco populado com dados iniciais.');
}

main()
  .catch((e) => {
    console.error('❌ Erro durante o seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
