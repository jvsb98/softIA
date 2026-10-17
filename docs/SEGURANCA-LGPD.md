# Segurança e LGPD

O que o Nimber Atende faz para proteger os dados de investidores e leads, e o que fica sob responsabilidade da operação.

## Acesso

| Controle | Como funciona |
|---|---|
| Senhas | bcrypt (custo 12). Tamanho mínimo configurável (padrão 10). Troca obrigatória no primeiro acesso e após redefinição. |
| 2FA | TOTP (RFC 6238), obrigatório para administradores por padrão e opcionalmente para todos. Segredo cifrado no banco. 8 códigos de recuperação de uso único, guardados como hash. |
| Bloqueio | 5 tentativas erradas bloqueiam a conta por 15 minutos. Login e verificação do 2FA limitados a 10 por minuto por IP. Tempo de resposta constante para e-mail inexistente. |
| Sessões | Cookie `HttpOnly`, `SameSite=Strict` e `Secure` quando o endereço público é HTTPS. O banco guarda só o hash SHA-256 do token. Expiração por inatividade (padrão 12 h). O usuário vê e encerra as próprias sessões. Desativar uma pessoa, redefinir a senha ou o 2FA dela encerra todas as sessões abertas. |
| CSRF | Além do `SameSite=Strict`, requisições de escrita com `Origin` de outro site são recusadas. |
| Papéis | Atendente, supervisor e administrador, com permissões extras por pessoa (fluxos, nós avançados, base de conhecimento, relatórios). As rotas da API conferem papel e permissão no servidor. |
| Primeiro administrador | Só pode ser criado com o banco vazio, sob trava no banco (duas tentativas simultâneas não criam dois). |

## Segredos

| Segredo | Onde fica | Proteção |
|---|---|---|
| Senha do PostgreSQL | `database.txt` | No Windows, cifrada com DPAPI (escopo da máquina) na primeira execução. Pasta restrita a Administradores e SYSTEM pelo instalador. No Docker, variável de ambiente. |
| Chave mestra (32 bytes) | `master.key` ou `NIMBER_MASTER_KEY` | No Windows, cifrada com DPAPI. Cifra todos os segredos abaixo. Não vai no backup do banco: guarde a saída de `export-key` num cofre de senhas. |
| Chaves de API de IA, senhas de bancos externos, segredos de 2FA e de webhooks | Banco | AES-256-GCM com a chave mestra. Chaves de IA nunca voltam para o navegador (só os últimos caracteres). |
| Logs | `data/logs` | Campos de senha, token, segredo, chave de API e cookies são substituídos por `[oculto]`. |

## Rede e navegador

- Cabeçalhos de segurança (Helmet) com Content-Security-Policy no painel.
- Limite global de 600 requisições por minuto por IP na API.
- Uploads limitados a 32 MB e 5 arquivos por envio.
- Requisições que o servidor faz a URLs informadas por usuários (importar site na base de conhecimento, nó HTTP, webhooks) passam por uma checagem a cada redirecionamento: só `http`/`https` e nunca o serviço de metadados da nuvem (169.254.169.254) nem endereços link-local. Endereços da rede interna continuam liberados de propósito (n8n, CRM, intranet).
- App desktop: isolamento de contexto e sandbox no Electron, sem Node.js no painel, navegação restrita ao servidor configurado, links externos abertos no navegador, permissões (notificações, área de transferência) só para o servidor.

## Consultas a outras bases

- Conexão em transação **somente leitura** (PostgreSQL e MySQL) com tempo limite; no SQL Server, use um usuário só com `db_datareader`.
- Só `SELECT`/`WITH`, sem `;`, sem comentários e sem comandos de escrita (validado antes de salvar e antes de executar). Parâmetros sempre vinculados, nunca concatenados.
- A IA escolhe uma consulta cadastrada e preenche parâmetros tipados; ela nunca escreve SQL.
- Consultas com dados pessoais podem exigir **verificação de identidade** (ex.: CPF + e-mail conferem) e só retornam os dados do próprio titular, por até 24 h.
- Máscaras por campo (CPF parcial, e-mail parcial, telefone parcial, ocultar) e lista de campos que podem sair.
- Toda execução fica registrada com parâmetros mascarados, origem (IA, fluxo, teste), linhas e tempo.

## IA e compliance

- Três travas fixas em todas as respostas: sem promessa ou projeção de rentabilidade, sem recomendação personalizada de investimento, sem orientação jurídica ou tributária.
- Três camadas: regras no prompt, filtro de padrões antes do envio e um modelo revisor (guarda). Resposta reprovada **não é enviada**: a conversa vai para um humano, o bloqueio entra na linha do tempo e na auditoria, e o Slack é avisado (se configurado).
- Disclaimer automático quando a resposta fala de retorno, rentabilidade, TIR etc. **O texto atual é uma proposta e precisa ser validado pelo compliance da Nimber.**
- Os dados enviados aos provedores de IA são o histórico recente da conversa, trechos da base de conhecimento e resultados de consultas liberadas. Verifique os termos de cada provedor (retenção e uso para treinamento) e prefira contas empresariais com retenção zero quando disponível.

## LGPD

| Princípio / direito | Como o sistema apoia |
|---|---|
| Finalidade e necessidade | Campos do contato limitados ao atendimento e qualificação. Consultas externas devolvem só os campos liberados. |
| Transparência | Respostas automáticas identificadas como assistente virtual (configure na persona do agente). |
| Oposição / revogação | Opt-out por palavra ("parar", "sair", "não quero mais"…) ou pelo atendente: bloqueia follow-ups e mensagens ativas. |
| Acesso e portabilidade | **Exportar dados do titular (LGPD)** no painel do contato (supervisor e admin): JSON com cadastro e histórico, registrado na auditoria. |
| Eliminação | **Anonimizar titular (LGPD)** no painel do contato (admin): remove nome, telefone, e-mail, perfil e o texto das mensagens, mantendo só números agregados para relatórios. Registrada na auditoria. |
| Retenção | Política automática: anonimizar conversas encerradas e apagar mídias depois de N dias (Configurações → Retenção de dados). |
| Segurança | Itens acima: criptografia de segredos, 2FA, auditoria, mínimo privilégio nas consultas. |
| Registro de operações | Auditoria de configurações, usuários, exportações, anonimizações, consultas e bloqueios de compliance. |

### Responsabilidades da operação

- Validar o disclaimer com o compliance e a base legal do tratamento com o jurídico/DPO.
- Definir os prazos de retenção (ativar em Configurações → Retenção de dados).
- Registrar a transferência internacional se a hospedagem for fora do Brasil (DigitalOcean não tem região no Brasil).
- Manter backup do banco e a chave mestra no cofre de senhas.
- Revisar periodicamente usuários ativos e a auditoria.

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Conexão do WhatsApp não oficial (Baileys, como o Extrator de Integrantes): violar os termos do WhatsApp pode levar ao bloqueio do número | Ritmo de envio humano, sem disparo em massa para quem não interagiu, follow-ups limitados e com opt-out, alerta quando a conexão cai. Para volume alto ou campanhas, avaliar a API oficial (WhatsApp Business Platform). |
| Nó "Código (JavaScript)" roda num contexto isolado com tempo limite de 1 s, mas **não é uma fronteira de segurança** | Só usuários com a permissão de nós avançados podem usá-lo. Conceda apenas à tecnologia. |
| Instaladores sem assinatura digital (aviso do SmartScreen) | Distribuir só pelos Releases do repositório privado, conferir o SHA-256 publicado. Para eliminar o aviso, comprar certificado de assinatura de código. |
| App desktop sem atualização automática | Reinstalar a versão nova quando houver (a configuração do usuário é mantida). |
