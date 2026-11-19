# Integração Core-Plugins: RabbitMQ

## 1. Contexto

Os plugins rodam em processo próprio e dependem de APIs externas que podem estar lentas, indisponíveis ou com limite de requisições. O core precisa enviar comandos aos plugins e receber deles os pedidos e as mudanças de status.

As ADRs (Architectural Decision Records) estão gravadas em `/docs/adr/0003-rabbitmq.md` (RabbitMQ) e `/docs/adr/0005-transactional-outbox.md` (outbox transacional).

## 2. Implementação

Contratos ficam em `libs/contracts` (@oms/contracts). As constantes estão no `config.ts`: exchange oms.commands, fila core.inbound, DLQ core.inbound.dlq, prefixo plugin. pras filas dos plugins, tamanho do lote do outbox e máximo de retentativas da entrada. As mensagens que chegam no Core estão no inbound.ts (OrderReceived, OrderCanceledByChannel, CommandProcessed) e os comandos no commands.ts.

A combinação que a gente fechou: exchange direct, routing key = id do plugin, fila plugin.<id>. Comando de pedido vai só pro plugin de origem. UPDATE_STOCK vai pra todos os plugins ativos que têm essa capacidade (findActiveByCapability no PluginRegistryService).

O core já conecta no RabbitMQ. O `MessagingModule` (`apps/core/src/messaging/messaging.module.ts`) declara a exchange oms.commands, a core.inbound (com DLX apontando pra core.inbound.dlq) e a própria DLQ. Sem broker o core não sobe. As filas plugin.<id> são de cada plugin: o core não declara.

Só `messaging/` e `outbox/` importam o `@golevelup/nestjs-rabbitmq`, e o core não usa cliente HTTP pra falar com plugin. As duas regras estão no `.dependency-cruiser.cjs` e rodam no `npm run lint:arch`.

**Saída do Core (outbox):** ninguém publica comando direto. O changeStatus do orders.service.ts grava o order_command (PENDING) e a linha na outbox_message na mesma transação da mudança de status, com o id da linha = command_id = commandId da mensagem. Se o plugin não tiver a capacidade, lança 422 e dá rollback de tudo. O UPDATE_STOCK segue o mesmo caminho: o StockService chama o `OutboxStockAvailabilityAdapter`, que grava uma linha por plugin ativo com a capacidade, na transação do evento de estoque.

**Relay:** o `OutboxRelayService` (`apps/core/src/outbox/outbox-relay.service.ts`) é o único ponto que publica comando. A cada 1 s pega até 50 linhas pendentes em ordem de seq com `FOR UPDATE SKIP LOCKED` e publica com `persistent` e `mandatory`. O published_at só é gravado depois do ack do broker e se a mensagem não voltou (basic.return, ou seja, não tinha fila ligada). Se falhar, incrementa attempts, grava last_error e para o lote ali, pra não passar na frente. Plugin parado ou broker fora do ar só deixam as linhas pendentes; o core continua aceitando pedido normalmente. De hora em hora apaga as publicadas há mais de 7 dias.

A entrega é at-least-once: se o relay cair entre o ack e o commit, a mesma mensagem sai de novo. O plugin descarta duplicata pelo commandId.

**Entrada no Core:** o `InboundConsumer` (`apps/core/src/messaging/inbound.consumer.ts`, no InboundModule) consome a core.inbound e chama o OrdersInboundHandler. Se o handle lançar erro, a mensagem é republicada com x-retry-count + 1; depois de MAX_INBOUND_RETRIES (3) vai pra core.inbound.dlq. JSON inválido vai direto pra DLQ. Mensagem repetida não quebra nada: pedido duplicado é ignorado pelo banco e CommandProcessed só atualiza comando que ainda tá PENDING (a repetida só gera um warn).

**Lado dos plugins:** publicar OrderReceived na core.inbound, consumir a plugin.<id> e responder CommandProcessed com o commandId. O registro e o heartbeat já estão prontos no libs/plugin-sdk, e as capacidades de cada plugin ficam no app.module dele. Nenhum dos dois declara RETURN_ORDER ainda, então /return em pedido de plugin dá 422.

## 3. Rodando local

Subir Postgres e RabbitMQ (painel em http://localhost:15672, usuário/senha oms):

```bash
docker compose up -d
```

As migrations de `database/migrations` são montadas no `docker-entrypoint-initdb.d`, mas o initdb só roda com volume novo. Se o volume já existia antes, aplica as que faltam na mão (003 a 005, a 005 cria a outbox_message):

```bash
docker compose exec -T postgres psql -U oms -d oms < database/migrations/005_outbox.sql
```

Copiar o `.env.example` pra `.env` (DATABASE_URL e RABBITMQ_URL) e então:

```bash
npm run test:int   # testes de integração (precisam do Postgres e do RabbitMQ no ar)
npm run lint:arch  # regras de dependência do core
```

**Pra testar sem plugin tem as rotas:** POST /orders (com pluginId e externalOrderId opcionais), /orders/:id/invoice, /ship, /return e /cancel. Com pluginId, os comandos ficam pendentes na outbox_message até existir a fila plugin.<id>.
