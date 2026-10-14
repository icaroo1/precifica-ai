// Precifica.ai — leitura de cardápio com a API da Anthropic (Claude).
// Roda como Netlify Edge Function em /api/ler-cardapio.
// Variáveis de ambiente (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY  (obrigatória) chave da API criada em console.anthropic.com
//   ANTHROPIC_MODEL    (opcional)    modelo usado; padrão claude-sonnet-5-5

const PROMPT = [
  'Você está lendo o cardápio de uma loja de delivery. As imagens são as páginas do cardápio, em ordem.',
  'Extraia TODOS os produtos vendidos que têm preço.',
  'Responda SOMENTE com linhas JSON, um objeto por linha, sem texto antes ou depois e sem markdown. Formato de cada linha:',
  '{"categoria":"Lanches","nome":"X-Burguer","preco":22.9}',
  'Regras:',
  '- "preco" é um número em reais com ponto decimal (R$ 22,90 vira 22.9).',
  '- Produto com tamanhos ou versões de preços diferentes: uma linha para cada, com o tamanho no nome. Ex.: "Pizza Calabresa (Média)".',
  '- Inclua bebidas e adicionais com preço (adicionais na categoria "Adicionais").',
  '- "categoria" é a seção do cardápio onde o produto aparece; se não houver seções, use "".',
  '- Ignore itens sem preço, taxa de entrega, telefones, horários e textos de promoção sem produto definido.',
  '- Escreva os nomes como aparecem no cardápio, corrigindo só erros óbvios de leitura. Não invente produtos nem preços.',
  '- Siga a ordem do cardápio.',
].join('\n');

const MAX_IMAGES = 8;                  // páginas por chamada (a página divide arquivos maiores)
const MAX_BODY = 12 * 1024 * 1024;     // 12 MB
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  // Só aceita chamadas feitas pela própria página do site.
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'forbidden' }, 403);

  const key = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!key) return json({ error: 'not_configured' }, 500);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }

  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!images.length || images.some((i) => !i || !TYPES.has(i.media_type) || typeof i.data !== 'string')) {
    return json({ error: 'bad_request' }, 400);
  }

  const ini = Number.parseInt(body.inicio, 10), fim = Number.parseInt(body.fim, 10), total = Number.parseInt(body.total, 10);
  let prompt = PROMPT;
  if (ini > 0 && fim >= ini && total > fim - ini + 1 && total <= 50) {
    prompt += `\n\nEstas são as páginas ${ini} a ${fim} de um cardápio com ${total} páginas. Extraia só o que aparece nelas.`;
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: Netlify.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5',
      max_tokens: 16000,
      stream: true,
      messages: [{
        role: 'user',
        content: [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.log('Anthropic error', upstream.status, detail.slice(0, 500));
    const code = upstream.status === 429 || upstream.status === 529 ? 'rate_limited' : 'upstream';
    return json({ error: code }, 502);
  }

  // Repassa o streaming direto para a página (evita o limite de tempo de resposta).
  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const config = { path: '/api/ler-cardapio' };
