const RESOLVED_OR_UNRESOLVED_PACKAGE_PREFIX = '(^|/node_modules/)';

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
        path: `${RESOLVED_OR_UNRESOLVED_PACKAGE_PREFIX}(axios|node-fetch|undici|@nestjs/axios)(/|$)`,
      },
    },
    {
      name: 'graphql-must-not-access-database',
      severity: 'error',
      comment:
        'GraphQL resolvers must use application services instead of database adapters.',
      from: {
        path: '^apps/core/src/graphql',
      },
      to: {
        path: '^apps/core/src/database',
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
