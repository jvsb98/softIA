# Guia de uso

Como o Nimber Atende funciona no dia a dia. Dividido por papel: **atendente**, **supervisor** e **administrador**.

## Como uma conversa anda

```
Cliente manda mensagem
   │
   ├─ fora do horário do setor ─────────► mensagem fixa (sem IA) e fila para o próximo horário
   │
   ├─ conexão com fluxo de entrada ─────► fluxo (menus, perguntas, IA, consultas…)
   │                                        │
   └─ sem fluxo ────────────────────────► agente de IA
                                            │
              qualificou / pediu humano / assunto sensível / trava de compliance
                                            ▼
                              Fila do setor (SDR, Closer, Suporte)
                                            ▼
                            Atendente assume, conversa e encerra
```

- Quando alguém da equipe responde **pelo celular** do número, a IA e o fluxo pausam naquela conversa.
- Nenhuma resposta da IA sai sem passar pelas travas de compliance. Se uma resposta for bloqueada, ela não é enviada: a conversa vai para um humano com o motivo.

## Atendente

### Caixa de entrada (Atendimento)

| Aba | O que mostra |
|---|---|
| **Minhas** | Conversas atribuídas a você. |
| **Fila** | Conversas aguardando alguém dos seus setores. Clique para assumir (no modo "puxar da fila") ou aguarde a distribuição automática. |
| **Automação** | Conversas sendo conduzidas pela IA ou por um fluxo. Dá para acompanhar e assumir quando quiser. |
| **Todas em atendimento** / **Encerradas** | Visão geral e histórico. |

### Na conversa

- **Enter** envia, **Shift+Enter** quebra a linha.
- **/** abre as respostas rápidas (ex.: `/boasvindas`).
- **Nota interna**: só a equipe vê. Use `@nome` para avisar um colega (ele recebe notificação).
- **Anexo**: imagem, documento ou áudio, até 32 MB.
- **Sugerir resposta**: a IA escreve um rascunho com base na conversa e na base de conhecimento. Revise antes de enviar.
- **Contexto da IA**: o que a IA entendeu (interesse, perfil, score de qualificação e por que transferiu).
- **Transferir**: escolha setor ou pessoa e o motivo. A conversa sai da sua lista.
- **Devolver para a automação**: a IA/fluxo volta a conduzir.
- **Encerrar**: escolha o motivo (Dúvida resolvida, Lead qualificado — reunião agendada, Sem interesse, Sem resposta do cliente…). O motivo fica no histórico da conversa.
- **Prioridade**: a bandeira destaca a conversa no topo da lista.

### Painel do contato (à direita)

Status do lead, etiquetas, campos, conversas anteriores e a opção **Não quer receber mensagens** (opt-out: bloqueia follow-ups e mensagens ativas).

### Iniciar conversa

Botão **Nova conversa** (no topo da lista): digite o telefone, escolha a conexão e escreva a primeira mensagem. Use para contatos que já falaram com a Nimber; mensagens em massa para quem nunca interagiu colocam o número em risco de bloqueio.

### Notificações

No navegador, permita as notificações quando o painel pedir. No app desktop elas são nativas do Windows, e o ícone da barra de tarefas ganha um ponto quando há pendências. Fechar a janela do app mantém ele na bandeja.

## Supervisor

- **Relatórios** (menu lateral): conversas por dia, quanto a automação resolveu sozinha, leads qualificados, motivos de transferência, funil de leads, tempos de espera e de primeira resposta por setor e por atendente, mapa de calor dos horários de pico e uso da IA. Filtre por período e por conexão; cada gráfico tem **Ver como tabela**.
- **Configurações → Setores e horários**: horário de cada setor, mensagem fora do horário e forma de distribuição. O limite de conversas simultâneas fica no cadastro de cada pessoa, em **Usuários**.
- **Usuários**, **Respostas rápidas**, **Etiquetas**, **Feriados**, **Follow-ups**, **Qualificação de leads**.
- **Fluxos**: montar e testar fluxos (veja abaixo).

### Follow-ups

Retomam conversas paradas, só com quem já falou com a Nimber: por padrão, uma tentativa após 24 h e outra após 72 h, dentro do horário. Param na hora se o contato responder ou pedir para parar ("parar", "sair", "não quero mais"…). A opção **Personalizar com IA** reescreve a mensagem retomando o último assunto (passando pelo compliance).

## Fluxos

**Fluxos → Novo fluxo** (ou a partir de um modelo: qualificação SDR, triagem de suporte, cadastro rápido).

1. Arraste os nós da paleta e ligue as saídas. Cada saída tem nome (ex.: "Sim", "Não", "Sem resposta", "Erro").
2. Clique num nó para editar. Use `{{variavel}}` e `{{contato.primeiro_nome}}` nos textos.
3. **Simular**: converse com o fluxo no painel lateral, sem WhatsApp. O caminho percorrido acende no desenho.
4. **Validar** aponta nós soltos, campos obrigatórios e saídas sem destino. Com erro, não publica.
5. **Publicar** cria uma versão. O rascunho continua editável sem afetar o que está no ar. **Versões** permite restaurar.
6. Ligue o fluxo a uma conexão em **Configurações → Conexões WhatsApp → Fluxo de entrada**.
7. Com o fluxo no ar, **Métricas** mostra quantas conversas passaram por cada nó e onde elas param.

| Grupo | Nós |
|---|---|
| Conversa | Enviar mensagem, Fazer pergunta (valida texto, número, e-mail, CPF com dígito, telefone, sim/não), Menu de opções |
| Lógica | Condição, Definir variável, Horário de atendimento, Aguardar |
| IA | Agente de IA, Classificar intenção (IA), Extrair dados (IA) |
| Ações | Transferir para humano, Adicionar etiqueta, Atualizar contato, Encerrar conversa, Fim do fluxo |
| Dados | Consultar base de dados (consultas cadastradas pela TI) |
| Avançados (só com permissão) | Requisição HTTP, Código (JavaScript) |

## Administrador

| Onde | Para quê |
|---|---|
| **Conexões WhatsApp** | Conectar números por QR Code, setor padrão e fluxo de entrada de cada um. |
| **Provedores e modelos** | Chaves de API (cifradas), modelo de cada tarefa e reserva automática se o principal falhar. |
| **Agente de IA** | Persona, objetivo, instruções e quais **consultas a outras bases** o agente pode usar. |
| **Transferência para humano** | Os 7 gatilhos: pedido explícito, lead qualificado, sem resposta na base, assunto sensível (resgate, reclamação, Procon, advogado), frustração, investidor com assunto da conta e falhas de entendimento seguidas. O atendente recebe um cartão de contexto gerado pela IA. |
| **Compliance** | Disclaimer e palavras que o disparam. As três travas são fixas. |
| **Consultas a outras bases** | Bancos somente leitura, consultas com parâmetros, máscaras de dados pessoais, verificação de identidade e o registro de execuções. |
| **Webhooks** | Avisar o n8n/CRM quando um lead é qualificado, uma conversa é transferida, encerrada etc. Cada envio é assinado (`X-Nimber-Signature: sha256=<HMAC do corpo>`). |
| **Alertas no Slack** | Avisos quando uma conexão cai ou o compliance bloqueia uma resposta. |
| **Ritmo de envio** | Intervalos e limites que imitam uma pessoa digitando (protege o número contra bloqueio). |
| **Política de acesso** | 2FA obrigatório para todos ou só admins, duração da sessão, tamanho mínimo de senha. |
| **Retenção de dados** | Anonimizar contatos e apagar mídias depois de N dias. |
| **Auditoria** | Quem fez o quê e quando. |
| **Saúde do sistema** | Banco, extensões, conexões, fila de tarefas e versão. |

### Papéis

| Papel | Pode |
|---|---|
| **Atendente** | Atender nos seus setores, notas, respostas rápidas, contatos. Com permissões extras no cadastro: editar fluxos (sem nós avançados), editar a base de conhecimento e ver relatórios. |
| **Supervisor** | Tudo do atendente, mais relatórios, fluxos, base de conhecimento, setores, usuários, etiquetas, feriados, follow-ups e qualificação. Nós avançados de fluxo só com a permissão marcada. |
| **Administrador** | Tudo, inclusive provedores de IA, agente, compliance, integrações, segurança, retenção e auditoria. |

### Validar a webhook no n8n

No nó **Webhook** do n8n, depois dele um nó **Code**:

```js
const crypto = require('crypto')
const assinatura = 'sha256=' + crypto.createHmac('sha256', 'SEU_SEGREDO').update(JSON.stringify($json.body)).digest('hex')
if (assinatura !== $json.headers['x-nimber-signature']) throw new Error('Assinatura inválida')
return $input.all()
```

(Para conferir byte a byte, ative "Raw Body" no nó Webhook e use o corpo bruto.)
