# ADR 4. Uso de GraphQL para a API de Consulta

**Status:** Aceita

## Contexto

O pedido universal reúne campos comuns à integração e muitos campos opcionais que existem apenas em canais específicos. Diferentes consumidores (como painel administrativo, logística e relatórios) precisam de recortes distintos desses dados e frequentemente consultam o saldo de estoque junto com os itens do pedido.

Alternativas consideradas:

- REST com endpoints e respostas fixos;
- REST com endpoints por consumidor ou seleção de campos via query params;
- GraphQL;
- gRPC.

## Decisão

Adotaremos uma API GraphQL somente de leitura no core, expondo os tipos `Pedido`, `ItemPedido`, `Estoque` e `Movimentacao`, alimentada pelas bases/projeções de leitura.

O GraphQL permite que cada cliente solicite exatamente os campos necessários e agregue pedido e estoque em uma única requisição, além de fornecer um schema fortemente tipado como contrato. Descartamos o REST por exigir manutenção constante de variações de payload, e o gRPC por não oferecer a mesma flexibilidade de consulta para clientes web. As operações de escrita permanecem fora do GraphQL.

## Consequências

### Positivas

A adoção do GraphQL reduz a quantidade de endpoints no core, permite que cada consumidor receba apenas os campos necessários em uma única chamada e facilita a evolução do pedido universal sem exigir novas versões de rota.

### Negativas

Em contrapartida, a flexibilidade das consultas aninhadas exige o uso de carregamento em lote (como DataLoader) para evitar o problema de N+1 leituras no banco, além da configuração de limites de profundidade e complexidade para proteger a aplicação.

Também abrimos mão da simplicidade do cache HTTP padrão, já que todas as requisições passam pelo mesmo endpoint, e passamos a manter interfaces separadas para leitura e escrita. Aceitamos esses custos porque manter múltiplos contratos REST para atender às variações de cada canal seria mais oneroso a longo prazo.

## Conformidade

O isolamento entre leitura e escrita será garantido por um teste em Jest que falha caso o schema montado exponha o tipo `Mutation`, somado a uma regra no dependency-cruiser que proíbe os resolvers de importarem o módulo do event store.

Já a proteção de performance será assegurada pela configuração do `graphql-depth-limit` para restringir a profundidade das consultas e por um teste em Jest que monitora a contagem de leituras no banco durante consultas aninhadas com o DataLoader ativo.
