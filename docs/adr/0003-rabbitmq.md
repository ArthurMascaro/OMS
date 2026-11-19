# ADR 3. RabbitMQ para a comunicação entre core e plugins

**Status**: Aceita

## Contexto 

Os plugins rodam em processo próprio e dependem de APIs externas que podem estar lentas, indisponíveis ou com limite de requisições. O core precisa enviar comandos aos plugins e receber deles os pedidos e as mudanças de status.

Alternativas consideradas:

- Chamadas REST síncronas entre core e plugins;
- Kafka para comunicação;
- RabbitMQ com filas ponto a ponto;
- Pub/sub entre core e plugins.

## Decisão

Adotaremos RabbitMQ para a comunicação entre core e plugins.
O core realiza a publicação dos comandos em uma exchange direta (oms.commands), usando o id do plugin como routing key. 

Cada plugin cria a sua fila de comandos e a liga à exchange com o próprio id. O core tem uma fila de entrada para pedidos e status vindos dos plugins. Mensagens com falha passam por re-tentativa e depois seguem para uma fila de erro (DLQ).

O core não deve esperar a resposta de um marketplace para concluir uma operação. A fila retém as mensagens enquanto o plugin ou o marketplace está fora. Os comandos têm destinatário definido, e a exchange direta faz esse roteamento por plugin sem configuração nova a cada plugin registrado.

## Consequências 

### Positivas

- O core continua respondendo com um marketplace fora do ar.
- Picos de pedidos são absorvidos pela fila.
- Um plugin novo precisa apenas criar a própria fila e ligá-la à exchange.

### Negativas

- O estoque publicado no marketplace fica atrasado por instantes em relação ao core.
- Política de “at-least once”, o core e plugins precisam tratar duplicatas pelo id.
- O broker é mais um componente para implantar, monitorar e prevenir quedas.
- Fluxo de ponta a ponta exige um identificador de correlação nas mensagens.

## Conformidade

Impede apps/core de importar cliente HTTP para comunicação livre. O core nunca chama um plugin por HTTP. Verificação pela API de gerenciamento do RabbitMQ, de que cada fila ligada a oms.commands tem um único consumidor.

Teste de resiliência que derruba um plugin, cria pedidos, sobe o plugin, confere o processamento das mensagens retidas e monitora o tamanho da DLQ.