# ADR 2. Uso de Event Sourcing para armazenar mudanças de estoque

Status: Aceita

## Contexto

O ciclo de vida dos pedidos, advindos de diversos canais, influencia diretamente os estoques dos itens. O sistema precisa explicar como chegou a um saldo, desfazer movimentações (cancelamento e devolução) e impedir que a mesma unidade seja vendida duas vezes.

Como o OMS centraliza pedidos de múltiplos marketplaces, é necessário manter um histórico confiável das movimentações de estoque, garantindo rastreabilidade e consistência mesmo diante de operações simultâneas.

Além disso, diferentes consumidores do sistema precisam consultar o saldo de estoque sem interferir nas operações de movimentação. Para isso, é necessário separar a responsabilidade de registrar eventos da responsabilidade de disponibilizar os saldos para consulta.

Alternativas consideradas:

- Saldo armazenado em uma coluna, alterado a cada operação.
- Saldo armazenado em uma coluna e uma tabela de histórico.
- Event Sourcing com o saldo derivado de eventos.

## Decisão

Utilizaremos uma arquitetura de Event Sourcing para gerenciar as movimentações de estoque, registrando cada operação como um evento imutável em uma tabela do PostgreSQL. Com os eventos como fonte da verdade, saldo e histórico não divergem, como pode ocorrer quando os dois são gravados separadamente.

O saldo físico, o reservado e o disponível serão calculados a partir dos eventos da referência. O saldo físico representa a quantidade de unidades existentes no estoque. O reservado representa a quantidade de unidades comprometidas com pedidos ainda não despachados. O disponível representa a quantidade que pode ser comercializada, calculada como físico menos reservado.

Será utilizada uma coluna de versão, com a restrição `UNIQUE (referencia, versao)`, garantindo uma sequência independente de eventos para cada referência. Cada evento também possuirá um identificador único e a identificação da operação de origem, permitindo reconhecer tentativas repetidas de processamento e impedir movimentações duplicadas.

O Event Store será gerenciado pelo módulo de estoque, responsável por registrar as movimentações como eventos imutáveis e garantir a integridade das operações. Um módulo independente de projeção processará assincronamente os eventos persistidos no PostgreSQL e manterá uma representação atualizada do estoque, contendo as quantidades física, reservada e disponível. A projeção poderá ficar temporariamente desatualizada em relação aos eventos registrados.

Quando uma movimentação alterar o saldo disponível, o módulo de estoque solicitará ao módulo de despacho de comandos a atualização dos marketplaces por meio dos plugins compatíveis.

## Consequências

Positivas:

- Toda alteração de saldo tem origem rastreável até o pedido.
- O saldo de qualquer data pode ser reconstruído.
- Erros são corrigidos com um evento de compensação, sem editar o passado.
- A projeção pode ser apagada e recriada a partir dos eventos.
- A identificação das operações permitirá garantir idempotência no processamento de mensagens repetidas.
- A separação entre escrita e leitura permite consultas independentes das operações de movimentação.

Negativas:

- A projeção pode apresentar consistência eventual, exibindo temporariamente um saldo desatualizado em relação aos eventos registrados.
- Escrita e leitura passam a ter modelos separados, aumentando a quantidade de componentes do core.
- O formato de um evento vira contrato permanente. Mudanças exigem versionamento.
- Referências com muitos eventos poderão precisar de snapshots no futuro.

## Conformidade

- O usuário de banco da aplicação não tem permissão de `UPDATE` nem de `DELETE` na tabela de eventos, já que é uma tabela imutável.
- Teste em Jest que reconstrói o saldo a partir dos eventos e compara com a projeção.
- Testes verificam a concorrência de duas reservas simultâneas da última unidade, em que só uma é aceita.
- Uma regra impede a escrita na projeção fora do módulo de projeção.
