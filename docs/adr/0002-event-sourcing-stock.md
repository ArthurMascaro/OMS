# ADR 2. Uso de Event Sourcing para armazenar mudanças de estoque

Status: Aceita

## Contexto

O ciclo de vida dos pedidos, advindos de diversos canais, influencia diretamente os estoques dos itens. O sistema precisa explicar como chegou a um saldo, desfazer movimentações (cancelamento e devolução) e impedir que a mesma unidade seja vendida duas vezes.

Como o OMS centraliza pedidos de múltiplos marketplaces, é necessário manter um histórico confiável das movimentações de estoque, garantindo rastreabilidade e consistência mesmo diante de operações simultâneas.

Além disso, diferentes consumidores do sistema precisam consultar o saldo de estoque sem interferir nas operações de movimentação. O saldo deve ser obtido a partir dos eventos registrados.

Alternativas consideradas:

- Saldo armazenado em uma coluna, alterado a cada operação.
- Saldo armazenado em uma coluna e uma tabela de histórico.
- Event Sourcing com o saldo derivado de eventos.

## Decisão

Utilizaremos uma arquitetura de Event Sourcing para gerenciar as movimentações de estoque, registrando cada operação como um evento imutável em uma tabela do PostgreSQL. Com os eventos como fonte da verdade, saldo e histórico não divergem, como pode ocorrer quando os dois são gravados separadamente.

O saldo físico, o reservado e o disponível serão calculados a partir dos eventos da referência. O saldo físico representa a quantidade de unidades existentes no estoque. O reservado representa a quantidade de unidades comprometidas com pedidos ainda não despachados. O disponível representa a quantidade que pode ser comercializada, calculada como físico menos reservado.

Cada evento possuirá um identificador único. Uma coluna de versão, com a restrição `UNIQUE (sku, version)`, garantirá uma sequência independente de eventos para cada referência. A concorrência será controlada de forma otimista: se duas transações tentarem gravar a mesma versão, a restrição única rejeitará uma delas, e a aplicação reverterá e repetirá a transação, recalculando o saldo.

O Event Store será gerenciado pelo módulo de estoque, responsável por registrar as movimentações como eventos imutáveis e garantir a integridade das operações. O módulo de estoque calculará o saldo diretamente a partir dos eventos. Se o volume de eventos tornar essas consultas custosas, snapshots poderão ser adicionados futuramente.

Quando uma movimentação alterar o saldo disponível, o módulo de estoque solicitará ao módulo de despacho de comandos a atualização dos marketplaces por meio dos plugins compatíveis.

## Consequências

Positivas:

- Toda alteração de saldo tem origem rastreável até o pedido.
- O saldo de qualquer data pode ser reconstruído.
- Erros são corrigidos com um evento de compensação, sem editar o passado.
- O saldo pode ser calculado sob demanda sem manter uma tabela de saldo separada.
- A restrição de versão única por SKU e a repetição da transação protegem as reservas concorrentes.

Negativas:

- O cálculo do saldo pode ficar mais custoso à medida que o histórico de eventos cresce.
- O formato de um evento vira contrato permanente. Mudanças exigem versionamento.
- SKUs com muitos eventos poderão precisar de snapshots no futuro.

## Conformidade

- O usuário de banco da aplicação não tem permissão de `UPDATE` nem de `DELETE` na tabela de eventos, já que é uma tabela imutável.
- Testes em Jest verificam o cálculo do saldo a partir dos eventos.
- Testes verificam a concorrência de duas reservas simultâneas da última unidade, em que só uma é aceita.
