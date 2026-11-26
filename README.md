# OMS

OMS é um sistema de gerenciamento de pedidos integrado a marketplaces por meio de plugins. O core expõe uma API REST para pedidos e registro de plugins, uma API GraphQL para consultas e usa PostgreSQL e RabbitMQ para persistência e comunicação assíncrona.

## Pré-requisitos

- Node.js (versão indicada em `.nvmrc`) e npm
- Docker com Docker Compose

## Executar localmente

Na raiz do projeto:

```bash
npm install
cp .env.example .env
docker compose up -d
```

O Compose inicia PostgreSQL (`localhost:5432`) e RabbitMQ (`localhost:5672`). As migrations em `database/migrations` são aplicadas automaticamente quando o PostgreSQL inicializa um volume vazio. Se o volume já existia antes de novas migrations serem adicionadas, aplique as migrations pendentes manualmente, em ordem.

Por exemplo, se o core retornar `relation "stock_balance_projection" does not exist`, aplique a migration que cria essa tabela:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U oms -d oms \
  < database/migrations/007_stock_balance_projection.sql
```

Execute somente migrations que ainda não foram aplicadas; a migration `007` reconstrói a projeção com base nos eventos de estoque existentes.

Inicie cada serviço em um terminal separado:

```bash
npm run start:core
npm run start:plugin-mercado-livre
npm run start:plugin-marketplace-b
```

Portas padrão:

| Serviço              | Endereço                 |
| -------------------- | ------------------------ |
| Core REST e GraphQL  | `http://localhost:3000`  |
| Plugin Mercado Livre | `http://localhost:3001`  |
| Plugin Marketplace B | `http://localhost:3002`  |
| RabbitMQ Management  | `http://localhost:15672` |

O painel do RabbitMQ usa `oms` como usuário e senha no Compose local. O core depende do PostgreSQL e do RabbitMQ para iniciar. As variáveis usadas pela aplicação estão em `.env.example`; `PORT` é opcional e, quando omitida, cada serviço usa sua porta padrão.

Verifique se o core está disponível:

```bash
curl http://localhost:3000/health
```

O GraphQL Playground está disponível em [http://localhost:3000/graphql](http://localhost:3000/graphql).

## Registrar plugins

Os plugins incluídos se registram automaticamente no core quando iniciam e enviam heartbeat a cada 10 segundos. Para registrar ou testar um plugin manualmente, envie seu manifesto para `POST /plugins/register`:

```bash
curl -i -X POST http://localhost:3000/plugins/register \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "mercado-livre",
    "marketplace": "Mercado Livre",
    "capabilities": [
      "INVOICE_ORDER",
      "CANCEL_ORDER",
      "SHIP_ORDER",
      "UPDATE_STOCK"
    ]
  }'
```

Uma chamada aceita responde `204 No Content`. O manifesto exige `id` e `marketplace` não vazios e capabilities válidas sem duplicação; registrar novamente o mesmo `id` atualiza o manifesto. Para manter um registro manual ativo, envie o heartbeat antes de expirar (30 segundos):

```bash
curl -i -X POST http://localhost:3000/plugins/mercado-livre/heartbeat
```

O heartbeat também responde `204 No Content`; se o plugin não estiver registrado, o core responde `404`.

Capabilities aceitas: `INVOICE_ORDER`, `CANCEL_ORDER`, `SHIP_ORDER`, `RETURN_ORDER` e `UPDATE_STOCK`. O core envia comandos para plugins ativos que declaram a capability correspondente. Os plugins de exemplo já declaram capabilities no código; neste estágio, eles demonstram registro e heartbeat.

## Criar e avançar pedidos pela API REST

Pedidos são criados pela API REST `POST /orders` (não há mutation GraphQL). Os valores monetários são centavos. Para associar o pedido a um canal, envie `pluginId` e `externalOrderId` juntos; ambos podem ser omitidos para um pedido sem plugin. Use um `externalOrderId` diferente para cada pedido do mesmo plugin.

```bash
curl -i -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "pluginId": "mercado-livre",
    "externalOrderId": "pedido-001",
    "items": [
      {
        "sku": "SKU-001",
        "quantity": 2,
        "unitPriceCents": 4990
      }
    ]
  }'
```

A resposta é `201 Created` e contém o ID do pedido:

```json
{ "id": "<order-uuid>" }
```

O pedido reserva estoque disponível: começa como `RESERVED` quando há estoque suficiente e como `CANCELED` quando não há. Em uma base local vazia, não há estoque inicial. Para preparar o SKU do exemplo uma única vez, registre uma entrada pela API do core:

```bash
curl -i -X POST http://localhost:3000/stock/receipts \
  -H 'Content-Type: application/json' \
  -d '{"sku":"SKU-001","quantity":10}'
```

A rota responde `204 No Content`. Não repita a chamada sem intenção de adicionar mais unidades ao estoque.

Guarde o UUID retornado. Com estoque disponível, o pedido fica `RESERVED`; avance-o para `INVOICED` e depois `SHIPPED`:

```bash
ORDER_ID='<order-uuid>'

# RESERVED -> INVOICED
curl -i -X POST "http://localhost:3000/orders/$ORDER_ID/invoice"

# INVOICED -> SHIPPED
curl -i -X POST "http://localhost:3000/orders/$ORDER_ID/ship"
```

Cada chamada bem-sucedida de transição responde `204 No Content`. Para cancelar, use a rota abaixo enquanto o pedido ainda está `RESERVED` (em vez de faturá-lo ou enviá-lo):

```bash
curl -i -X POST "http://localhost:3000/orders/$ORDER_ID/cancel" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Solicitação do cliente"}'
```

O fluxo permitido é `RESERVED -> INVOICED` ou `CANCELED`, `INVOICED -> SHIPPED` e `SHIPPED -> RETURNED`. Para retornar um pedido enviado:

```bash
curl -i -X POST "http://localhost:3000/orders/$ORDER_ID/return"
```

Essa rota requer que o plugin declare a capability `RETURN_ORDER`; os plugins de exemplo não a declaram. Tentativas de transições inválidas ou sem capability são rejeitadas pelo core. Com `pluginId`, os comandos também são publicados assincronamente pelo RabbitMQ conforme a configuração de outbox. Não há endpoint REST `GET` para consultar pedidos; use as queries GraphQL abaixo.

## Consultas GraphQL

As operações GraphQL implementadas são queries de pedidos, estoque e movimentações. Os exemplos podem ser executados no Playground em `/graphql`.

Listar pedidos e consultar os saldos dos SKUs de cada pedido:

```graphql
query ListOrders {
  orders {
    id
    pluginId
    externalOrderId
    status
    totalCents
    items {
      sku
      quantity
      unitPriceCents
    }
    stock {
      sku
      physical
      reserved
      available
    }
    createdAt
    updatedAt
  }
}
```

Consultar um pedido específico:

```graphql
query GetOrder($id: ID!) {
  order(id: $id) {
    id
    status
    cancelReason
    totalCents
    items {
      sku
      quantity
      unitPriceCents
    }
  }
}
```

Variáveis:

```json
{ "id": "<order-uuid>" }
```

Consultar o saldo e o histórico de movimentações de um SKU:

```graphql
query GetStock($sku: String!) {
  stock(sku: $sku) {
    sku
    physical
    reserved
    available
  }
  movements(sku: $sku) {
    eventId
    type
    sku
    version
    quantity
    orderId
    occurredAt
  }
}
```

Variáveis:

```json
{ "sku": "SKU-001" }
```

Filtrar movimentações por pedido:

```graphql
query OrderMovements($orderId: ID!) {
  movements(orderId: $orderId) {
    eventId
    type
    sku
    quantity
    orderId
    occurredAt
  }
}
```

## Desenvolvimento e testes

```bash
npm run build
npm test
npm run test:int
npm run lint:arch
```

Os testes de integração precisam do PostgreSQL e RabbitMQ em execução. Para mais detalhes sobre filas, retry e outbox, consulte [docs/rabbitmq/README.md](docs/rabbitmq/README.md).
