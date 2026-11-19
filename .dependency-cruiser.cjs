/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'rabbitmq-so-em-messaging-e-outbox',
      comment:
        'Só messaging/ e outbox/ falam com o RabbitMQ. O resto do core grava no ' +
        'outbox e o relay publica (ADR 0003 e 0005).',
      severity: 'error',
      from: {
        path: '^apps/core/src/',
        pathNot: '^apps/core/src/(messaging|outbox)/',
      },
      to: {
        path: '@golevelup/nestjs-rabbitmq',
      },
    },
    {
      name: 'core-sem-cliente-http',
      comment:
        'O core nunca chama plugins por HTTP: comandos vão pelo RabbitMQ ' +
        '(ADR 0003).',
      severity: 'error',
      from: {
        path: '^apps/core/src/',
      },
      to: {
        // Casa o módulo resolvido em node_modules e também o não resolvido
        // (pacote não instalado), que aparece só pelo nome.
        path: '(^|/node_modules/)(axios|node-fetch|undici|@nestjs/axios)(/|$)',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
