# ADR 2. Uso de Event Sourcing para armazenar mudanças de estoque

Status: Aceita

## Contexto

O ciclo de vida dos pedidos, provenientes de diversos canais, influencia diretamente o estoque dos itens. O sistema precisa explicar como chegou a determinado saldo, desfazer movimentações em casos de cancelamento e devolução e impedir que uma mesma unidade seja vendida mais de uma vez.

Como o OMS centraliza pedidos de múltiplos marketplaces, é necessário manter um histórico confiável das movimentações de estoque, com rastreabilidade e consistência diante de operações simultâneas.

O sistema também precisa consultar saldo e histórico sem alterar os registros que representam as movimentações. O histórico deve permanecer como fonte da verdade, enquanto as consultas de saldo devem contar com uma estrutura adequada para leitura.

Alternativas consideradas:

- Armazenar o saldo em uma coluna e alterá-lo a cada operação.
- Armazenar o saldo em uma coluna e manter uma tabela de histórico.
- Usar Event Sourcing, registrando as movimentações como eventos e derivando o saldo desses eventos.

## Decisão

Adotaremos Event Sourcing para gerenciar o estoque. Cada movimentação será registrada como um evento imutável em stock_event, que será a fonte da verdade. O saldo será derivado desses eventos, enquanto uma projeção oferecerá uma leitura eficiente dos saldos.

Cada evento terá uma versão por referência. A restrição `UNIQUE (sku, version)` e a repetição da transação em caso de conflito protegerão gravações concorrentes. Quando houver um pedido relacionado, a mudança de estado do pedido e seus eventos de estoque serão gravados na mesma transação. Se o volume de eventos tornar a atualização custosa, snapshots poderão ser adicionados no futuro.

A projeção manterá os saldos físico e reservado e a última versão aplicada por referência. O disponível será calculado como físico menos reservado. Quando consultada, ela aplicará os eventos ainda pendentes. Os consumidores acessarão a projeção pelo contrato do módulo, e movimentos serão consultados no histórico de eventos.

## Consequências

Positivas:

- Toda movimentação é rastreável por um evento; quando vinculada a um pedido, o evento identifica esse pedido.
- O saldo de qualquer data pode ser reconstruído.
- Erros são corrigidos com um evento de compensação, sem editar o passado.
- A projeção pode ser reconstruída a partir dos eventos.
- A restrição de versão única e a repetição da transação protegem gravações concorrentes.
- As consultas de saldo não precisam recalcular todo o histórico a cada leitura.

Negativas:

- A projeção pode ficar temporariamente atrás dos eventos até uma consulta atualizá-la.
- O cálculo do saldo pode ficar mais custoso à medida que o histórico de eventos cresce.
- O formato de um evento vira contrato permanente. Mudanças exigem versionamento.
- Referências com muitos eventos poderão precisar de snapshots no futuro.

## Conformidade

- Uma trigger no banco rejeita operações `UPDATE` e `DELETE` na tabela stock_event.
- A gravação da tabela stock_balance_projection é responsabilidade do serviço do módulo de projeção; os consumidores recebem apenas seu contrato de consulta.
- A projeção registra a última versão aplicada e atualiza o saldo somente com os eventos posteriores a essa versão.
- A restrição única (sku, version) e a repetição de transações em conflito garantem a sequência de eventos por referência.
