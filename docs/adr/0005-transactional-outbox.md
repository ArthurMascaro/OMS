# ADR 5. Transactional Outbox para a publicação de comandos aos plugins

**Status**: Aceita

## Contexto

A ADR 3 define que o core publica comandos na exchange `oms.commands` do RabbitMQ. Esses comandos nascem de mudanças gravadas no PostgreSQL: a mudança de status de um pedido (`changeStatus`) e a alteração do saldo disponível de um SKU (módulo de estoque). Gravar no banco e publicar no broker são duas operações em sistemas diferentes, sem transação compartilhada (problema de dual-write). Os dois casos de falha são:

- Publicar antes do commit: se o commit falhar, o plugin recebe um comando de um pedido que não existe. Se o plugin responder `CommandProcessed` antes do commit ficar visível, `completeCommand` não encontra a linha, registra um aviso e o comando fica `PENDING` para sempre.
- Publicar depois do commit: se o processo cair entre o commit e a publicação, o comando é perdido. O pedido muda de status, mas o marketplace nunca é avisado. Hoje o `UPDATE_STOCK` já funciona assim, com `notifyAvailabilityChanges` chamado depois da transação.

Alternativas consideradas:

- Publicar dentro da transação, antes do commit;
- Publicar depois do commit, aceitando a perda em caso de queda;
- Transactional Outbox com um relay que publica as mensagens gravadas;
- Change Data Capture (por exemplo, Debezium) lendo o WAL do PostgreSQL;
- Two-phase commit (XA) entre PostgreSQL e RabbitMQ.

## Decisão

Adotaremos o padrão Transactional Outbox. Em vez de publicar no RabbitMQ, o core grava a mensagem em uma tabela `outbox_message` do PostgreSQL, na mesma transação que altera o estado do negócio. O commit passa a ser o único ponto de decisão: ou a mudança e a mensagem existem juntas, ou nenhuma das duas existe.

A tabela `outbox_message` terá um identificador único (que será o `commandId` ou o `messageId` da mensagem), uma sequência crescente para ordenação, a routing key (id do plugin), o tipo, o payload em JSON, `created_at`, `published_at`, o número de tentativas e o último erro. Um índice parcial sobre as linhas com `published_at IS NULL` mantém a busca de pendentes barata.

Os pontos de escrita são:

- `changeStatus`: insere a linha em `order_command` e a linha do outbox na mesma transação, com o mesmo `commandId`. A capacidade do plugin de origem é verificada dentro da transação; se não houver, o erro desfaz a mudança de status;
- módulo de estoque: ao gravar os eventos que alteram o saldo disponível, grava dentro da mesma transação uma linha do outbox por plugin ativo com a capacidade `UPDATE_STOCK`, encontrado por `findActiveByCapability`. A porta `StockAvailabilityPort` passa a receber o `PoolClient` da transação em vez de ser chamada após o commit.

Um relay dentro do core lê as mensagens pendentes em intervalos curtos, com `SELECT ... WHERE published_at IS NULL ORDER BY seq FOR UPDATE SKIP LOCKED LIMIT n`, publica cada uma na exchange `oms.commands` esperando a confirmação do broker (publisher confirms) e só então marca `published_at`. Se a publicação falhar, a linha continua pendente, o contador de tentativas aumenta e o relay tenta de novo. O `SKIP LOCKED` permite mais de uma instância do core sem publicar a mesma linha duas vezes ao mesmo tempo. Mensagens já publicadas são removidas depois de um período de retenção.

O relay entrega com a garantia "at-least-once", a mesma política da ADR 3. Se o processo cair depois da publicação e antes de marcar `published_at`, a mensagem será publicada de novo. Os plugins já precisam tratar duplicatas pelo `commandId`.

O consumo da `core.inbound` não usa o outbox. O handler já é idempotente (pedido duplicado é ignorado pelo banco e `CommandProcessed` só atualiza comando `PENDING`), então basta confirmar a mensagem (ack) depois que o `handle` terminar sem erro.

Não usaremos CDC nem two-phase commit. O CDC exige um componente a mais para operar (Debezium e Kafka Connect ou equivalente), desproporcional para o volume do projeto. O XA não é suportado pelo RabbitMQ.

## Consequências

### Positivas

- A mudança de estado e o comando correspondente são atômicos: não há comando órfão nem comando perdido por queda entre o commit e a publicação.
- O `UPDATE_STOCK` deixa de ser publicado fora da transação e passa a ter a mesma garantia dos comandos de pedido.
- Se o RabbitMQ estiver fora do ar, o core continua gravando. As mensagens acumulam no outbox e são publicadas quando o broker voltar.
- A tabela serve de auditoria do que foi enviado, quando e com quantas tentativas.

### Negativas

- Latência a mais entre o commit e a publicação, limitada pelo intervalo de leitura do relay.
- O relay é mais um componente para monitorar. É preciso acompanhar a quantidade de linhas pendentes e a idade da mais antiga.
- A garantia continua sendo "at-least-once". Duplicatas são tratadas pelo `commandId` no plugin.
- A ordem entre mensagens do mesmo plugin é por `seq`, mas transações que confirmam fora de ordem e várias instâncias do relay podem entregar fora de ordem. Isso importa para o `UPDATE_STOCK`, em que o valor mais recente deve prevalecer. O payload leva `issuedAt` para o plugin descartar valores mais antigos.
- A decisão de quais plugins recebem o `UPDATE_STOCK` é tomada no momento da gravação. Um plugin que se registrar depois não recebe mensagens anteriores e deve consultar o saldo atual ao entrar.
- Se a exchange direta não tiver fila ligada à routing key (plugin que nunca subiu e criou a fila), o RabbitMQ descarta a mensagem sem erro. O relay deve publicar com a flag `mandatory` e tratar o retorno como falha de publicação.
- A tabela cresce e exige rotina de limpeza das mensagens já publicadas.

## Conformidade

- Nenhum código fora do relay chama o `publish` do RabbitMQ para comandos. A regra é verificada com o dependency-cruiser, já usado no projeto.
- Teste de integração que força falha na transação (por exemplo, plugin sem a capacidade do comando) e confere que não existe linha no `outbox_message` nem mensagem na fila.
- Teste de resiliência que derruba o RabbitMQ, altera pedidos e estoque, sobe o broker e confere que todas as mensagens pendentes chegam às filas dos plugins.
- Teste que derruba o processo do relay depois da publicação e antes de marcar `published_at`, e confere que a duplicata é descartada pelo `commandId`.
- Monitoramento da quantidade de linhas com `published_at IS NULL` e da idade da mais antiga, com alerta quando passar de um limite definido.
