# ADR 1. Adoção de Microkernel com plugins remotos e descoberta dinâmica por registro

Status: Aceita

## Contexto

O Projeto OMS integra vários Marketplaces, e cada um tem sua própria API, formato de pedido e regras/comportamentos de operação próprios. A lista de marketplaces pode mudar consideravelmente, como também suas regras internas. O Núcleo de pedido, estoque e regras internas muda pouco.

Alternativas consideradas:

- Monólito em camadas com as integrações embutidas no código.
- Microsserviços com coreografia, um serviço por marketplace.
- Microkernel com plugins carregados dentro do processo do core.
- Microkernel com plugins remotos e registro de plugins.

## Decisão

Adotaremos o estilo microkernel, com um core e plugin por marketplace.

O core mantém o pedido universal, o estoque, o registro de plugins e suas devidas regras. Cada plugin é uma aplicação NestJS em processo próprio. Ao subir, o plugin se registra no core por HTTP com um manifesto base (id, marketplace e capacidades) e passa a enviar heartbeat. O core removerá do registro o plugin que parar de responder.

O core só invoca plugins pelo registro e consulta as capacidades antes de enviar um comando (Ex: um marketplace pode não aceitar criação de etiqueta, enquanto outro sim, isso é uma capacidade da integração). Plugins não realizam comunicação entre si.

A variação do sistema está concentrada nos marketplaces, e a extensibilidade é uma característica arquitetural prioritária. O registro permite adicionar um marketplace sem que nada adicional seja implementado no core. O processo próprio isola o core das falhas de um marketplace. As capacidades declaradas no manifesto base evitam condicionais por marketplace dentro do core. Carregar plugins dentro do processo do core foi descartado porque a injeção de dependência do NestJS é montada na inicialização e uma falha do plugin afetaria o core.

## Consequências

Positivas:

- Um marketplace novo vira um plugin novo, sem alteração no core
- o core funciona e pode ser testado sem nenhum plugin
- A falha de um plugin não derruba o core nem os outros plugins

Negativas:

- O sistema tem um único quantum. O core é ponto único de falha e limita escalabilidade e elasticidade.
- Plugins remotos trazem problemas de sistemas distribuídos, como complexidade e indisponibilidade de rede.
- O contrato do core vira um ponto crítico. Uma mudança de contrato/comportamento exige atualização em todos os plugins
- Quando o marketplace não tem determinada capacidade (por exemplo, faturar), o pedido fica faturado no core e sem reflexo no marketplace.

Aceitamos as consequências pois o volume esperado cabe em um core único e o custo de incluir um marketplace pesa mais do que a escalabilidade.

## Conformidade

- Validação no CI que falha se algo do core importar de plugins, ou se um plugin importar de outro. Core e plugins podem compartilhar uma pasta de libs externa.
- Teste e2e que sobe um plugin com o core em execução e verifica o registro.
- Teste e2e que executa o core sem plugins, cria pedido, movimenta o estoque e percorre o fluxo.

## Notas

Autor: Arthur Mascaro
