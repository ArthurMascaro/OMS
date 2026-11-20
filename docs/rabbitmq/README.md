# Integração Core-Plugins: RabbitMQ

## 1. Contexto

Os plugins rodam em processo próprio e dependem de APIs externas que podem estar lentas, indisponíveis ou com limite de requisições. O core precisa enviar comandos aos plugins e receber deles os pedidos e as mudanças de status.

As ADRs (Architectural Decision Records) estão gravadas em `/docs/adr/0003-rabbitmq.md` (RabbitMQ) e `/docs/adr/0005-transactional-outbox.md` (outbox transacional).

## 2. Implementação

Contratos ficam em `libs/contracts` (@oms/contracts). As constantes estão no `config.ts`: exchange oms.commands, fila core.inbound, DLQ core.inbound.dlq, prefixo `plugin.` das filas dos plugins, tamanho do lote do outbox e máximo de retentativas da entrada. As mensagens que chegam no Core estão no inbound.ts (OrderReceived, OrderCanceledByChannel, CommandProcessed) e os comandos no commands.ts.

A combinação que a gente fechou: exchange direct, routing key = id do plugin, fila plugin.<id>. Comando de pedido vai só pro plugin de origem. UPDATE_STOCK vai pra todos os plugins ativos que têm essa capacidade (findActiveByCapability no PluginRegistryService).

O core já conecta no RabbitMQ. O `MessagingModule` (`apps/core/src/messaging/messaging.module.ts`) declara a exchange oms.commands, a core.inbound (com DLX apontando pra core.inbound.dlq) e a própria DLQ. Sem broker o core não sobe (não usamos `connectionInitOptions.wait = false`). As filas plugin.<id> são de cada plugin: o core não declara.

O `MessagingModule` não importa módulo de negócio. O consumer da core.inbound fica num módulo separado, o `InboundModule`, porque ele precisa do `OrdersModule`, e `OrdersModule -> OutboxModule -> MessagingModule` fecharia um ciclo. O `@RabbitSubscribe` é achado pelo `RabbitMQModule` (global) em qualquer módulo, então essa separação não muda nada no consumo.

Só `messaging/` e `outbox/` importam o `@golevelup/nestjs-rabbitmq`, e o core não usa cliente HTTP pra falar com plugin. As duas regras estão no `.dependency-cruiser.cjs` e rodam no `npm run lint:arch`.

**Saída do Core (outbox):** ninguém publica comando direto. O changeStatus do orders.service.ts grava o order_command (PENDING) e a linha na outbox_message na mesma transação da mudança de status, com o id da linha = command_id = commandId da mensagem. Se o plugin não tiver a capacidade, lança 422 e dá rollback de tudo. O UPDATE_STOCK segue o mesmo caminho: o StockService chama o `OutboxStockAvailabilityAdapter`, que grava uma linha por plugin ativo com a capacidade, na transação do evento de estoque.

**Relay:** o `OutboxRelayService` (`apps/core/src/outbox/outbox-relay.service.ts`) é o único ponto que publica comando. A cada 1 s pega até 50 linhas pendentes em ordem de seq com `FOR UPDATE SKIP LOCKED`, ignorando as routing keys em backoff, e publica com `persistent` e `mandatory`. Uma execução só começa quando a anterior terminou. O published_at só é gravado depois do ack do broker e se a mensagem não voltou (basic.return, ou seja, não tinha fila ligada). De hora em hora apaga as publicadas há mais de 7 dias.

Ordem e falhas, por plugin (routing key):

- A ordem é garantida dentro de cada plugin, por seq. Um plugin não segura os outros.
- Se a publicação de uma linha do plugin A falha, incrementa attempts, grava last_error e põe `next_attempt_at` (backoff de 2^attempts s, no máximo 60 s). As linhas seguintes de A no lote são puladas, e enquanto o backoff não vence o relay ignora todas as pendentes de A, inclusive as gravadas depois. Assim nenhuma linha de A passa na frente de uma mais antiga, e o log de falha sai no máximo uma vez por período de backoff. As linhas dos outros plugins continuam saindo.
- Plugin que nunca criou a fila `plugin.<id>` (ou foi desativado) cai nesse caso: as linhas dele ficam pendentes, em backoff, até a fila existir.
- Falha que não é unroutable (timeout de confirmação, conexão caída, nack do broker) também põe backoff na routing key, mas encerra o lote: com o broker fora, cada lote espera no máximo um timeout de confirmação (10 s) segurando os locks.
- Com mais de uma instância do core rodando o relay, o `SKIP LOCKED` evita publicar a mesma linha duas vezes ao mesmo tempo, mas não garante a ordem: uma instância pode publicar uma linha de A enquanto a anterior está travada pela outra. Transações que confirmam fora de ordem de seq têm o mesmo efeito. A premissa de deploy é uma instância do relay; o `issuedAt` do payload permite ao plugin descartar `UPDATE_STOCK` mais antigo.

Plugin parado ou broker fora do ar só deixam as linhas pendentes; o core continua aceitando pedido normalmente.

Detalhes da lib que o relay usa:

- O canal padrão do `AmqpConnection` (golevelup) é um ConfirmChannel: o `publish` só resolve depois do basic.ack do broker. A opção `timeout` vai pro ChannelWrapper do amqp-connection-manager e rejeita a promessa se o ack não chegar a tempo.
- Com `mandatory`, a mensagem sem fila volta como basic.return ANTES do basic.ack, e o ack ainda vem positivo. Por isso o relay guarda os messageIds devolvidos pelo evento `return` do canal e confere depois do ack (`wasReturnedAsUnroutableBeforeConfirm`).
- O listener de `return` é registrado com `managedChannel.addSetup`, que roda no canal atual e de novo a cada reconexão. O `relayOnce` também aguarda esse registro, porque um `TestingModule` compilado sem `init()` não roda o `onModuleInit`.
- Não há `@types/amqplib` no projeto, então os tipos usados do amqplib são recortes locais (`AmqplibReturnedMessage`, `AmqplibConsumeMessage` etc.).

**Monitoramento:** o `GET /health` do core continua com `status: "ok"` e ganhou o campo `outbox`, com `pending` (linhas não publicadas) e `oldestPendingAgeSeconds` (idade da mais antiga, `null` se não há pendente). Os dois vêm de `OutboxRelayService.stats()`. Idade crescendo indica plugin sem fila ou broker fora.

**Desligamento:** o `main.ts` chama `enableShutdownHooks()`. No SIGTERM o relay para de agendar novos lotes e espera o lote em andamento terminar antes de o Nest fechar a conexão AMQP.

A entrega é at-least-once: se o relay cair entre o ack e o commit, a mesma mensagem sai de novo. O plugin descarta duplicata pelo commandId.

**Entrada no Core:** o `InboundConsumer` (`apps/core/src/messaging/inbound.consumer.ts`, no InboundModule) consome a core.inbound e chama o OrdersInboundHandler. Por padrão o golevelup faz nack COM requeue quando o handler lança, o que vira loop infinito, então o consumer trata o erro: se ainda há tentativas, republica a mensagem na core.inbound com x-retry-count + 1 (esperando a confirmação do broker) e só então dá ack na original; depois de MAX_INBOUND_RETRIES (3) devolve `Nack(false)` e o DLX da fila leva pra core.inbound.dlq. Erros fora do handler (JSON inválido, falha ao republicar) caem no `errorHandler`, que faz nack sem requeue: vão direto pra DLQ. A fila é declarada só pelo `MessagingModule` (com o DLX); o consumer usa `createQueueIfNotExists: false` pra não redeclarar com outros argumentos.

Mensagem repetida não quebra nada: pedido duplicado é ignorado pelo banco, cancelamento pelo canal de um pedido já CANCELED só gera um log, e CommandProcessed só atualiza comando que ainda tá PENDING (a repetida só gera um warn). Cancelamento pelo canal de pedido que não pode mais ir pra CANCELED (INVOICED, SHIPPED etc.) continua lançando e termina na DLQ.

**DLQ:** não existe ferramenta de reprocessamento. As mensagens da core.inbound.dlq ficam lá até alguém olhar no painel do RabbitMQ (Queues > core.inbound.dlq > Get messages) e decidir: descartar, ou corrigir a causa e mover de volta pra core.inbound (o "Move messages" do painel depende do plugin `rabbitmq_shovel_management` habilitado no broker).

**Lado dos plugins:** publicar OrderReceived na core.inbound, consumir a plugin.<id> e responder CommandProcessed com o commandId. O registro e o heartbeat já estão prontos no libs/plugin-sdk, e as capacidades de cada plugin ficam no app.module dele. Nenhum dos dois declara RETURN_ORDER ainda, então /return em pedido de plugin dá 422.

## 3. Rodando local

Subir Postgres e RabbitMQ (painel em http://localhost:15672, usuário/senha oms):

```bash
docker compose up -d
```

As migrations de `database/migrations` são montadas no `docker-entrypoint-initdb.d`, mas o initdb só roda com volume novo. Se o volume já existia antes, aplica as que faltam na mão, em ordem (003 e 004 são do estoque, 005 cria a outbox_message e 006 adiciona o `next_attempt_at` do backoff):

```bash
for migration in database/migrations/00{3,4,5,6}_*.sql; do
  docker compose exec -T postgres psql -U oms -d oms < "$migration"
done
```

Copiar o `.env.example` pra `.env` (DATABASE_URL e RABBITMQ_URL) e então:

```bash
npm run test:int   # testes de integração (precisam do Postgres e do RabbitMQ no ar)
npm run lint:arch  # regras de dependência do core
```

Os testes do relay (`apps/core/test/outbox-relay.int-spec.ts`) conferem contagens exatas de publicação e o `stats()`, então exigem que não haja linha pendente na outbox_message de fora do teste; se houver, o teste avisa antes de rodar. Os demais testes de integração só olham as linhas que eles criam. O teste de resiliência derruba a conexão AMQP e espera a reconexão do amqp-connection-manager, que tenta de novo a cada 5 s (`reconnectTimeInSeconds`, que sem configuração assume o valor do intervalo de heartbeat).

**Pra testar sem plugin tem as rotas:** POST /orders (com pluginId e externalOrderId opcionais), /orders/:id/invoice, /ship, /return e /cancel. Com pluginId, os comandos ficam pendentes na outbox_message até existir a fila plugin.<id>.
