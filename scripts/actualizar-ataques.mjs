#!/usr/bin/env node
/* Actualiza data/ataques.json con los ataques con drones contra la Fuerza Pública
   reportados en los últimos VENTANA_DIAS días.

   - Fuente automática: búsqueda en Google News (RSS, prensa colombiana).
   - De cada titular se extrae municipio (data/municipios.json), institución,
     muertos/heridos y autoría citada; las notas del mismo municipio con pocos días
     de diferencia se agrupan como un solo ataque.
   - data/ataques-verificados.json: casos revisados a mano; tienen prioridad sobre
     los automáticos del mismo hecho.

   Sin dependencias (Node 20+). Lo ejecuta .github/workflows/actualizar-ataques.yml. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIAS = Number(process.env.VENTANA_DIAS || 30);
const AHORA = new Date();
const DESDE = new Date(AHORA.getTime() - DIAS * 864e5);
const MISMO_HECHO_DIAS = 7;

const CONSULTAS = [
  '(dron OR drones) ataque (policía OR "estación de policía" OR subestación)',
  '(dron OR drones) ataque (soldados OR militares OR ejército OR batallón)',
  '(dron OR drones) (armada OR "infante de marina" OR "infantes de marina")',
  '(dron OR drones) explosivos (uniformados OR "fuerza pública") heridos',
  '(dron OR drones) ("base militar" OR helicóptero OR "fuerza aeroespacial")',
];

/* ---------- Utilidades de texto ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
// Normaliza carácter por carácter (mismo largo que el original) para poder
// recuperar del titular el nombre con sus tildes y mayúsculas.
const norm = (s) => [...s].map((c) => {
  const b = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return /^[a-z0-9]$/.test(b) ? b : ' ';
}).join('');
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]).trim() : ''; };

/* ---------- Municipios ---------- */
const NO_USAR = new Set(['colombia', 'la paz', 'union', 'la union', 'concordia', 'victoria', 'la victoria', 'belen', 'calarca', 'marquetalia',
  'restrepo', 'sucre', 'caldas', 'cordoba', 'bolivar', 'narino', 'santander', 'cauca', 'huila', 'meta', 'choco', 'cesar', 'magdalena', 'antioquia',
  'boyaca', 'tolima', 'arauca', 'casanare', 'putumayo', 'guaviare', 'amazonas', 'vaupes', 'vichada', 'guainia', 'caqueta', 'providencia', 'el paso',
  'la estrella', 'la cruz', 'el rosario', 'nacional', 'paz', 'ataco', 'carolina', 'salgar', 'mosquera', 'ricaurte', 'ospina',
  'murillo', 'florida', 'argentina', 'puerto rico', 'venecia', 'valencia', 'toledo']);
const ALIAS = { 'El Carmen|Chocó': ['el carmen de atrato'], 'Cartagena|Bolívar': ['cartagena de indias'] };
const DEPTOS = {
  'Amazonas': ['amazonas'], 'Antioquia': ['antioquia', 'bajo cauca', 'uraba antioqueno'], 'Arauca': ['arauca'], 'Atlántico': ['atlantico'],
  'Bolívar': ['bolivar', 'sur de bolivar'], 'Boyacá': ['boyaca'], 'Caldas': ['caldas'], 'Caquetá': ['caqueta'], 'Casanare': ['casanare'],
  'Cauca': ['cauca', 'norte del cauca'], 'Cesar': ['cesar', 'sur del cesar'], 'Chocó': ['choco'], 'Córdoba': ['cordoba'], 'Cundinamarca': ['cundinamarca'],
  'Guainía': ['guainia'], 'Guaviare': ['guaviare'], 'Huila': ['huila'], 'La Guajira': ['la guajira', 'guajira'], 'Magdalena': ['magdalena'],
  'Meta': ['meta'], 'Nariño': ['narino'], 'Norte de Santander': ['norte de santander', 'catatumbo'], 'Putumayo': ['putumayo'], 'Quindío': ['quindio'],
  'Risaralda': ['risaralda'], 'Santander': ['santander'], 'Sucre': ['sucre'], 'Tolima': ['tolima'], 'Valle del Cauca': ['valle del cauca', 'valle'],
  'Vaupés': ['vaupes'], 'Vichada': ['vichada'],
};
// Desempate cuando el nombre existe en varios departamentos y el titular no lo dice.
const PRIORIDAD = ['Cauca', 'Norte de Santander', 'Valle del Cauca', 'Chocó', 'Antioquia', 'Bolívar', 'Nariño', 'Huila', 'Cesar', 'Arauca',
  'Putumayo', 'Caquetá', 'Guaviare', 'Meta', 'Tolima', 'Córdoba', 'Santander'];

const municipios = JSON.parse(readFileSync(join(RAIZ, 'data/municipios.json'), 'utf8'));
const indice = [];
for (const m of municipios) {
  const base = m.n.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const paren = [...m.n.matchAll(/\(([^)]+)\)/g)].map((x) => x[1]);
  const alias = new Set([base, ...paren, ...(ALIAS[`${m.n}|${m.d}`] || [])].map((a) => norm(a).replace(/\s+/g, ' ').trim()).filter((a) => a.length > 3 && !NO_USAR.has(a)));
  for (const a of alias) indice.push({ a, m });
}
indice.sort((x, y) => y.a.length - x.a.length); // primero los nombres más largos

function buscarMunicipio(titulo) {
  const t = norm(titulo);
  const deptos = Object.entries(DEPTOS).filter(([, ks]) => ks.some((k) => new RegExp(`\\b${k}\\b`).test(t))).map(([d]) => d);
  const hallados = [];
  let ocupado = t;
  for (const { a, m } of indice) {
    const re = new RegExp(`\\b${a.replace(/ /g, '\\s+')}\\b`);
    const r = re.exec(ocupado);
    if (!r) continue;
    // Un nombre que también es departamento solo cuenta si dice "municipio de".
    if (Object.values(DEPTOS).flat().includes(a) && !new RegExp(`municipio de\\s+${a}`).test(t)) continue;
    // "vereda Altamira", "gobernadora Carolina"...: no es el municipio.
    if (/\b(vereda|corregimiento|barrio|sector|caserio|resguardo|rio|sitio|hacienda|finca|alias|gobernadora?|alcaldesa?|general|coronel)\s+$/.test(t.slice(Math.max(0, r.index - 16), r.index))) continue;
    hallados.push({ m, idx: r.index, len: r[0].length });
    ocupado = ocupado.slice(0, r.index) + ' '.repeat(r[0].length) + ocupado.slice(r.index + r[0].length);
  }
  if (!hallados.length) return null;
  // Primer nombre citado; si el titular nombra un departamento, se prefiere un
  // municipio que exista en ese departamento.
  hallados.sort((x, y) => x.idx - y.idx);
  const enDepto = hallados.find((h) => municipios.some((m) => norm(m.n) === norm(h.m.n) && deptos.includes(m.d)));
  const primero = enDepto || hallados[0];
  const nombre = norm(primero.m.n);
  const candidatos = municipios.filter((m) => norm(m.n) === nombre);
  let elegido = candidatos.find((m) => deptos.includes(m.d));
  const probable = !elegido && candidatos.length > 1;
  if (!elegido) elegido = candidatos.slice().sort((x, y) => (PRIORIDAD.indexOf(x.d) + 1 || 99) - (PRIORIDAD.indexOf(y.d) + 1 || 99))[0];
  return { ...elegido, textoOriginal: titulo.slice(primero.idx, primero.idx + primero.len), probable };
}

/* ---------- Clasificación del titular ---------- */
const REQ_DRON = /\bdron(es)?\b/;
const REQ_ATAQUE = /\b(ataque|ataques|atacan|atacaron|atacada|atacado|atacar|atentado|hostig\w*|lanzad\w*|explosiv\w*|bombarde\w*|enjambre|arremet\w*)\b/;
const REQ_FUERZA = /\b(policia|policias|uniformad\w*|soldad\w*|militar\w*|ejercito|armada|infantes?|marina|estacion|subestacion|batallon|brigada|base militar|tropas?|fuerza publica|helicoptero|aeronave|fuerza aeroespacial|fuerza aerea|radar|patrulla\w*|cai)\b/;
const EXCLUIR = /\b(israel\w*|gaza\w*|palestin\w*|genocidio|libano|siria|yemen|sudan|espana|europa|otan|tanques|invisibles|tecnologia|creada|desarrollan|destruy\w*|desactiv\w*|frustr\w*|hallazgo|halla\w*|evitan|impiden|captur\w*|neutraliz\w*|derrib\w*|incaut\w*|antidron\w*|inhib\w*|cifras?|balance|informe|record|analisis|como responder|prohib\w*|recompensa|toque de queda|denuncia\w*|alerta temprana|consejo de seguridad|entrenamiento|curso|feria|exhibicion|proyecto de ley|escudo|ucrania|rusia|israel|gaza|iran|mexico|ecuador|venezuela|peru|haiti|estados unidos|eeuu|van \d+|asi funciona|que se sabe de los)\b/;

const NUM = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20 };
const N = `(\\d+|${Object.keys(NUM).join('|')})`;
const aNum = (s) => (/^\d+$/.test(s) ? Number(s) : NUM[s]);
// Separa víctimas civiles (o detenidos) de las de la Fuerza Pública según el
// sustantivo que acompaña al número.
const CIVIL = /\b(civil\w*|personas?|menores?|ninos?|ninas?|mujer\w*|habitantes?|campesin\w*|indigenas?|internos?|detenidos?|reclusos?|familia\w*|bebe|adultos?)\b/;
function victimas(t) {
  const r = { heridos: null, muertos: null, civilesHeridos: null, civilesMuertos: null };
  const sumar = (k, n) => { r[k] = (r[k] || 0) + n; };
  for (const h of t.matchAll(new RegExp(`\\b${N}\\s+((?:[a-z]+\\s+){0,3}?)(?:resultaron\\s+|quedaron\\s+|estan\\s+|quedan\\s+)?heridos?\\b`, 'g'))) {
    if (CIVIL.test(h[2])) sumar('civilesHeridos', aNum(h[1])); else if (r.heridos == null) r.heridos = aNum(h[1]);
  }
  for (const m of t.matchAll(new RegExp(`\\b${N}\\s+((?:[a-z]+\\s+){0,4}?)(?:muertos?|murio|murieron|muere|mueren|asesinados?|fallecidos?)\\b`, 'g'))) {
    if (CIVIL.test(m[2])) sumar('civilesMuertos', aNum(m[1])); else if (r.muertos == null) r.muertos = aNum(m[1]);
  }
  const m2 = new RegExp(`\\b(?:muere|murio|mueren|murieron|asesinan a|matan a)\\s+${N}\\s+([a-z]+)`).exec(t);
  if (m2 && r.muertos == null) { if (CIVIL.test(m2[2])) sumar('civilesMuertos', aNum(m2[1])); else r.muertos = aNum(m2[1]); }
  return r;
}
function institucion(t) {
  if (/\b(armada|infantes? de marina|guardacostas|fluvial)\b/.test(t)) return 'armada';
  if (/\b(policia|policias|estacion|subestacion|patrullero\w*|cai)\b/.test(t)) return 'policia';
  if (/\b(fuerza aeroespacial|fuerza aerea|aerocivil|aeronautica|radar|aeropuerto)\b/.test(t)) return 'aerea';
  if (/\b(ejercito|soldad\w*|militar\w*|batallon|brigada|tropas?|helicoptero)\b/.test(t)) return 'ejercito';
  return 'sin';
}
function autoria(titulo) {
  const grupos = [[/\beln\b/i, 'ELN'], [/disidencias?/i, 'Disidencias de las FARC'], [/estado mayor central|\bemc\b/i, 'Estado Mayor Central'],
    [/clan del golfo|\bagc\b|gaitanistas/i, 'Clan del Golfo'], [/segunda marquetalia/i, 'Segunda Marquetalia'], [/jaime mart[ií]nez/i, 'Bloque Jaime Martínez'],
    [/autodefensas conquistadoras/i, 'Autodefensas Conquistadoras de la Sierra Nevada']];
  const g = grupos.find(([re]) => re.test(titulo));
  return g ? `${g[1]} (según la prensa)` : 'No indicada en los titulares';
}
const fechaCO = (d) => new Date(d.getTime() - 5 * 36e5).toISOString().slice(0, 10); // hora de Colombia (UTC-5)

/* ---------- Descarga y extracción ---------- */
async function rss(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${DIAS}d`)}&hl=es-419&gl=CO&ceid=CO:es-419`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (GRUSE-75 panel; actualizacion de ataques)' } });
  if (!r.ok) throw new Error(`Google News respondió ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((x) => {
    const it = x[1];
    const fuente = tag(it, 'source');
    let titulo = tag(it, 'title');
    if (fuente && titulo.endsWith(` - ${fuente}`)) titulo = titulo.slice(0, -(fuente.length + 3));
    return { titulo: titulo.trim(), fuente, url: tag(it, 'link'), fecha: new Date(tag(it, 'pubDate')) };
  });
}

const notas = new Map();
let fallos = 0;
for (const q of CONSULTAS) {
  try { for (const n of await rss(q)) if (!notas.has(n.titulo)) notas.set(n.titulo, n); }
  catch (e) { fallos++; console.error(`Consulta fallida (${q}): ${e.message}`); }
}
if (fallos === CONSULTAS.length) { console.error('Ninguna consulta respondió; se conserva el archivo anterior.'); process.exit(1); }

const candidatas = [];
const descartes = { fuera: 0, filtro: 0, sinLugar: 0 };
for (const n of notas.values()) {
  if (!(n.fecha >= DESDE && n.fecha <= new Date(AHORA.getTime() + 864e5))) { descartes.fuera++; continue; }
  const t = norm(n.titulo);
  if (!REQ_DRON.test(t) || !REQ_ATAQUE.test(t) || !REQ_FUERZA.test(t) || EXCLUIR.test(t)) { descartes.filtro++; continue; }
  const lugar = buscarMunicipio(n.titulo);
  if (!lugar) { descartes.sinLugar++; continue; }
  candidatas.push({ ...n, lugar, inst: institucion(t), ...victimas(t), autoria: autoria(n.titulo) });
}

// Agrupa notas del mismo municipio separadas por pocos días: un solo ataque.
candidatas.sort((a, b) => a.fecha - b.fecha);
const grupos = [];
for (const c of candidatas) {
  const g = grupos.find((x) => x.lugar.n === c.lugar.n && x.lugar.d === c.lugar.d && (c.fecha - x.ultima) / 864e5 <= MISMO_HECHO_DIAS);
  if (g) { g.notas.push(c); g.ultima = c.fecha; } else grupos.push({ lugar: c.lugar, notas: [c], ultima: c.fecha });
}
const moda = (vals) => { const v = vals.filter((x) => x != null); if (!v.length) return null; return Math.max(...v); };
const frecuente = (vals, def) => { const c = {}; vals.filter((v) => v && v !== def).forEach((v) => (c[v] = (c[v] || 0) + 1)); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || def; };

const automaticos = grupos.map((g) => {
  const primera = g.notas[0];
  const fuentes = [];
  for (const n of g.notas) if (!fuentes.some((f) => f.nombre === n.fuente) && fuentes.length < 3) fuentes.push({ nombre: n.fuente || 'Google News', url: n.url });
  return {
    fecha: fechaCO(primera.fecha), fechaTipo: 'reporte', municipio: primera.lugar.textoOriginal.trim(), depto: primera.lugar.d,
    inst: frecuente(g.notas.map((n) => n.inst), 'sin'), objetivo: primera.titulo, muertos: moda(g.notas.map((n) => n.muertos)),
    heridos: moda(g.notas.map((n) => n.heridos)), civilesHeridos: moda(g.notas.map((n) => n.civilesHeridos)),
    civilesMuertos: moda(g.notas.map((n) => n.civilesMuertos)), autoria: frecuente(g.notas.map((n) => n.autoria), 'No indicada en los titulares'),
    fuentes, notas: g.notas.length, lat: primera.lugar.lat, lon: primera.lugar.lon, verificado: false, ubicacionProbable: primera.lugar.probable,
  };
});

/* ---------- Casos verificados a mano ---------- */
const verificadosArchivo = JSON.parse(readFileSync(join(RAIZ, 'data/ataques-verificados.json'), 'utf8'));
const verificados = verificadosArchivo.ataques.filter((a) => new Date(`${a.fecha}T12:00:00-05:00`) >= DESDE)
  .map((a) => ({ ...a, verificado: true }));
const mismoHecho = (a, v) => norm(v.depto) === norm(a.depto) && (norm(v.municipio).includes(norm(a.municipio).trim()) || norm(a.municipio).includes(norm(v.municipio).split('(')[0].trim()))
  && Math.abs(new Date(a.fecha) - new Date(v.fecha)) / 864e5 <= MISMO_HECHO_DIAS;
// Notas viejas que Google News vuelve a fechar como recientes: mismo municipio y
// mismas cifras que un caso verificado anterior a la ventana.
const repeticion = (a, v) => norm(v.depto) === norm(a.depto) && norm(v.municipio).includes(norm(a.municipio).trim())
  && a.muertos != null && a.heridos != null && a.muertos === v.muertos && a.heridos === v.heridos;
const excluir = (verificadosArchivo.excluirTitulares || []).map(norm);
const nuevos = automaticos.filter((a) => !verificados.some((v) => mismoHecho(a, v))
  && !verificadosArchivo.ataques.some((v) => repeticion(a, v))
  && !excluir.some((x) => norm(a.objetivo).includes(x)));

// La búsqueda no devuelve siempre las mismas notas: los automáticos de la corrida
// anterior que sigan en la ventana se conservan si esta vez no aparecieron.
const destino = join(RAIZ, 'data/ataques.json');
const anterior = existsSync(destino) ? JSON.parse(readFileSync(destino, 'utf8')) : null;
const conservados = (anterior?.ataques || []).filter((a) => !a.verificado && new Date(`${a.fecha}T12:00:00-05:00`) >= DESDE
  && ![...verificados, ...nuevos].some((b) => mismoHecho(a, b))
  && !verificadosArchivo.ataques.some((v) => repeticion(a, v))
  && !excluir.some((x) => norm(a.objetivo).includes(x)));

const ataques = [...verificados, ...nuevos, ...conservados].sort((a, b) => b.fecha.localeCompare(a.fecha));
const salida = {
  generado: AHORA.toISOString(), ventanaDias: DIAS, desde: fechaCO(DESDE), hasta: fechaCO(AHORA),
  metodo: 'Búsqueda automática en Google News (prensa colombiana) cada 3 horas + casos verificados a mano',
  cifras: verificadosArchivo.cifras, ataques,
};

const sinCambios = anterior && JSON.stringify({ ...anterior, generado: 0 }) === JSON.stringify({ ...salida, generado: 0 });
if (!sinCambios) writeFileSync(destino, `${JSON.stringify(salida, null, 1)}\n`);
console.log(JSON.stringify({ notas: notas.size, descartes, candidatas: candidatas.length, automaticos: automaticos.length, nuevos: nuevos.length, conservados: conservados.length, verificados: verificados.length, total: ataques.length, sinCambios: !!sinCambios }));
