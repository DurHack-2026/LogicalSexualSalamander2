
(function () {
'use strict';
var $ = function (s) { return document.querySelector(s); };
var cssCache = {};
var cssv = function (n) {
    if (!(n in cssCache)) cssCache[n] = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return cssCache[n];
};
var DEG = Math.PI / 180;

/* ---------- state ---------- */
var room = { shape: 'rect', customPoly: null, customDoors: [], customWindows: [], w: 420, l: 360, h: 250, wallColor: '#2B3A35', transparentWalls: true, floorTexture: 'wood' };
var items = [];
var selId = null;
var uid = 1;
var roomPersistenceEnabled = false;
var roomStorageRestoreFailed = false;
var floorTextureTiles = Object.create(null);
var floorThreeTextures = Object.create(null);
var trellisState = {
configured: false,
statusLoaded: false,
statusError: '',
savedModels: [],
savedModelsError: '',
activeJob: null,
generationErrors: Object.create(null),
roomErrors: Object.create(null)
};
var threeModelCache = Object.create(null);

/* ---------- helpers ---------- */
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; }
function gbp(n) { return '£' + Math.round(n).toLocaleString('en-GB'); }
function lum(hex) {
var c = hex.replace('#', '');
var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
return 0.299 * r + 0.587 * g + 0.114 * b;
}
function getFloorTextureTile(type) {
if (floorTextureTiles[type]) return floorTextureTiles[type];
var tile = document.createElement('canvas'), size = type === 'carpet' ? 128 : 256;
tile.width = size; tile.height = size;
var context = tile.getContext('2d');
if (type === 'wood') {
    var plankHeight = size / 4;
    for (var row = 0; row < 4; row++) {
        var y = row * plankHeight;
        context.fillStyle = row % 2 ? '#B99166' : '#C7A77B';
        context.fillRect(0, y, size, plankHeight);
        context.strokeStyle = 'rgba(86, 59, 34, 0.42)'; context.lineWidth = 2;
        context.beginPath(); context.moveTo(0, y); context.lineTo(size, y); context.stroke();
        context.beginPath();
        var joint = row % 2 ? size / 2 : 0;
        context.moveTo(joint, y); context.lineTo(joint, y + plankHeight);
        context.moveTo(joint + size / 2, y); context.lineTo(joint + size / 2, y + plankHeight);
        context.stroke();
        for (var grain = 0; grain < 3; grain++) {
            var grainY = y + 12 + grain * 15;
            context.strokeStyle = 'rgba(112, 78, 45, 0.16)'; context.lineWidth = 1;
            context.beginPath(); context.moveTo(0, grainY);
            context.bezierCurveTo(size * 0.3, grainY - 5, size * 0.65, grainY + 5, size, grainY - 2);
            context.stroke();
        }
    }
} else if (type === 'carpet') {
    context.fillStyle = '#B8B4A8'; context.fillRect(0, 0, size, size);
    var seed = 1931;
    function random() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    for (var fiber = 0; fiber < 1100; fiber++) {
        var x = random() * size, y = random() * size;
        var shade = random() > 0.5 ? '91, 87, 77' : '245, 242, 232';
        context.strokeStyle = 'rgba(' + shade + ', ' + (0.12 + random() * 0.2) + ')';
        context.lineWidth = 1; context.beginPath(); context.moveTo(x, y);
        context.lineTo(x + random() * 2, y + 1 + random() * 2); context.stroke();
    }
} else {
    context.fillStyle = '#E7E3DC'; context.fillRect(0, 0, size, size);
    for (var vein = 0; vein < 5; vein++) {
        context.strokeStyle = vein % 2 ? 'rgba(126, 137, 143, 0.2)' : 'rgba(117, 125, 132, 0.32)';
        context.lineWidth = vein % 2 ? 1 : 2;
        context.beginPath();
        for (var step = 0; step <= size; step += 4) {
            var curveY = vein * size / 5 + 10 * Math.sin(step / size * Math.PI * 2 + vein) +
                3 * Math.sin(step / size * Math.PI * 6 + vein * 2);
            if (step === 0) context.moveTo(step, curveY);
            else context.lineTo(step, curveY);
        }
        context.stroke();
    }
}
floorTextureTiles[type] = tile;
return tile;
}
function getThreeFloorTexture(type) {
if (floorThreeTextures[type]) return floorThreeTextures[type];
var texture = new THREE.CanvasTexture(getFloorTextureTile(type));
texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
texture.repeat.set(0.01, 0.01);
texture.userData = texture.userData || {};
texture.userData.shared = true;
floorThreeTextures[type] = texture;
return texture;
}

/* =====================================================
    MODULE 1. Room generation
    ===================================================== */
function roomPoly(r) {
var w = r.w, l = r.l;
if (r.shape === 'custom' && Array.isArray(r.customPoly) && r.customPoly.length >= 3) {
    return r.customPoly.map(function (p) { return [Math.round(p[0] * w), Math.round(p[1] * l)]; });
}
if (r.shape === 'L') {
    var cw = Math.round(w * 0.4), cl = Math.round(l * 0.42);
    return [[0, 0], [w - cw, 0], [w - cw, cl], [w, cl], [w, l], [0, l]];
}
if (r.shape === 'bay') {
    var a = Math.round(l * 0.16), x0 = Math.round(w * 0.25), x1 = Math.round(w * 0.75);
    return [[0, a], [x0, a], [x0, 0], [x1, 0], [x1, a], [w, a], [w, l], [0, l]];
}
return [[0, 0], [w, 0], [w, l], [0, l]];
}

function roomOpenings(r) {
var w = r.w, l = r.l, d1 = 30, d2 = Math.min(120, w - 30);
var door = { x0: d1, x1: d2, y: l };
var win;
if (r.shape === 'L') {
    var top = Math.round(w - w * 0.4), c = top / 2, half = Math.min(70, top / 2 - 20);
    win = { x0: c - half, x1: c + half, y: 0 };
} else if (r.shape === 'bay') {
    var bayWindowWidth = Math.min(240, w / 2, Math.max(60, w * 0.2));
    win = { x0: (w - bayWindowWidth) / 2, x1: (w + bayWindowWidth) / 2, y: 0 };
} else {
    var halfWindow = Math.min(120, w / 4);
    win = { x0: w / 2 - halfWindow, x1: w / 2 + halfWindow, y: 0 };
}
return { door: door, win: win };
}

function polyArea(p) {
var a = 0;
for (var i = 0; i < p.length; i++) { var q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
return Math.abs(a) / 2;
}
function pointInPoly(pt, poly) {
var x = pt[0], y = pt[1], inside = false;
for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
}
return inside;
}
function customDoorGeometry(door, poly) {
if (!door || door.edgeIndex < 0 || door.edgeIndex >= poly.length) return null;
var a = poly[door.edgeIndex], b = poly[(door.edgeIndex + 1) % poly.length];
var dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
if (length < 1) return null;
var p0 = [a[0] + dx * door.t0, a[1] + dy * door.t0];
var p1 = [a[0] + dx * door.t1, a[1] + dy * door.t1];
var hinge = door.hingeAtStart ? p0 : p1;
var other = door.hingeAtStart ? p1 : p0;
var gapLength = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
var along = [(other[0] - hinge[0]) / gapLength, (other[1] - hinge[1]) / gapLength];
var area = 0;
for (var i = 0; i < poly.length; i++) {
    var next = poly[(i + 1) % poly.length];
    area += poly[i][0] * next[1] - next[0] * poly[i][1];
}
var inward = area >= 0 ? [-dy / length, dx / length] : [dy / length, -dx / length];
var swingNormal = door.swingInward ? inward : [-inward[0], -inward[1]];
var swingEnd = [hinge[0] + swingNormal[0] * gapLength, hinge[1] + swingNormal[1] * gapLength];
var arc = [];
for (var step = 0; step <= 8; step++) {
    var angle = Math.PI * 0.5 * step / 8;
    arc.push([
        hinge[0] + gapLength * (along[0] * Math.cos(angle) + swingNormal[0] * Math.sin(angle)),
        hinge[1] + gapLength * (along[1] * Math.cos(angle) + swingNormal[1] * Math.sin(angle))
    ]);
}
return {
    edgeIndex: door.edgeIndex,
    t0: door.t0,
    t1: door.t1,
    start: p0,
    end: p1,
    hinge: hinge,
    swingEnd: swingEnd,
    arc: arc,
    zone: [p0, p1, [p1[0] + inward[0] * 60, p1[1] + inward[1] * 60], [p0[0] + inward[0] * 60, p0[1] + inward[1] * 60]]
};
}
function customDoorGeometries(poly) {
return (room.customDoors || []).map(function (door) { return customDoorGeometry(door, poly); })
    .filter(function (door) { return !!door; });
}
function customWindowGeometry(windowItem, poly) {
if (!windowItem || windowItem.edgeIndex < 0 || windowItem.edgeIndex >= poly.length) return null;
var a = poly[windowItem.edgeIndex], b = poly[(windowItem.edgeIndex + 1) % poly.length];
var dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
if (length < 1) return null;
var start = [a[0] + dx * windowItem.t0, a[1] + dy * windowItem.t0];
var end = [a[0] + dx * windowItem.t1, a[1] + dy * windowItem.t1];
return {
    edgeIndex: windowItem.edgeIndex,
    t0: windowItem.t0,
    t1: windowItem.t1,
    start: start,
    end: end,
    width: Math.hypot(end[0] - start[0], end[1] - start[1]),
    sillHeightCm: windowItem.sillHeightCm,
    heightCm: windowItem.heightCm
};
}
function customWindowGeometries(poly) {
return (room.customWindows || []).map(function (windowItem) { return customWindowGeometry(windowItem, poly); })
    .filter(function (windowItem) { return !!windowItem; });
}
function roomDoorGeometries(poly) {
if (room.shape === 'custom') return customDoorGeometries(poly);
var preset = roomOpenings(room).door;
var opening = segmentInterval(poly, [preset.x0, preset.y], [preset.x1, preset.y]);
if (!opening) return [];
return [customDoorGeometry(Object.assign(opening, {
    hingeAtStart: false,
    swingInward: true
}), poly)].filter(function (door) { return !!door; });
}
function roomWindowGeometries(poly) {
if (room.shape === 'custom') return customWindowGeometries(poly);
var preset = roomOpenings(room).win;
var opening = segmentInterval(poly, [preset.x0, preset.y], [preset.x1, preset.y]);
if (!opening) return [];
var sillHeightCm = 95;
return [customWindowGeometry(Object.assign(opening, {
    sillHeightCm: sillHeightCm,
    heightCm: Math.min(110, room.h - sillHeightCm)
}), poly)].filter(function (windowItem) { return !!windowItem; });
}

/* =====================================================
    MODULE 2. Furniture data from links
    ===================================================== */
var STOP = { www: 1, p: 1, product: 1, products: 1, item: 1, gb: 1, en: 1, uk: 1, us: 1, html: 1, htm: 1, shop: 1, buy: 1, pd: 1, dp: 1, collections: 1, catalog: 1, detail: 1 };
var CATS = [
{ id: 'sofa', re: /sofa|couch|settee|loveseat/, label: 'Sofa', w: 210, d: 92, h: 84, price: [450, 1400], color: '#8A9A8B', mat: 'Fabric' },
{ id: 'armchair', re: /armchair|recliner|accent chair|lounge chair/, label: 'Armchair', w: 85, d: 88, h: 85, price: [220, 700], color: '#B07A5A', mat: 'Fabric' },
{ id: 'coffee', re: /coffee table|side table|bedside|nightstand|end table/, label: 'Coffee table', w: 100, d: 55, h: 42, price: [90, 320], color: '#B98F62', mat: 'Oak' },
{ id: 'bed', re: /\bbed\b|bedframe|mattress|divan/, label: 'Bed', w: 150, d: 205, h: 100, price: [350, 1100], color: '#9AA3B5', mat: 'Fabric' },
{ id: 'dining', re: /dining table|\btable\b/, label: 'Dining table', w: 160, d: 90, h: 75, price: [200, 800], color: '#A47C55', mat: 'Oak' },
{ id: 'desk', re: /desk/, label: 'Desk', w: 140, d: 70, h: 75, price: [120, 420], color: '#C8B08A', mat: 'Birch' },
{ id: 'chair', re: /chair|stool|bench/, label: 'Chair', w: 46, d: 52, h: 86, price: [45, 180], color: '#6F7F8E', mat: 'Wood' },
{ id: 'wardrobe', re: /wardrobe|armoire|closet/, label: 'Wardrobe', w: 100, d: 58, h: 200, price: [180, 700], color: '#E3E0D8', mat: 'Wood' },
{ id: 'bookcase', re: /bookcase|bookshelf|shelving|shelf/, label: 'Bookcase', w: 80, d: 30, h: 180, price: [70, 260], color: '#B08B62', mat: 'Pine' },
{ id: 'sideboard', re: /sideboard|tv unit|cabinet|dresser|drawers|console/, label: 'Sideboard', w: 150, d: 40, h: 58, price: [140, 520], color: '#7A5A44', mat: 'Walnut' },
{ id: 'lamp', re: /lamp|light/, label: 'Lamp', w: 38, d: 38, h: 160, price: [35, 180], color: '#2A2F33', mat: 'Metal' },
{ id: 'rug', re: /rug|carpet/, label: 'Rug', w: 200, d: 140, h: 1, price: [60, 350], color: '#B9B5AB', mat: 'Wool' },
{ id: 'plant', re: /plant|ficus|monstera/, label: 'Plant', w: 40, d: 40, h: 110, price: [20, 90], color: '#4F7D55', mat: 'Ceramic pot' }
];
var COLOURS = {
grey: '#8E9396', gray: '#8E9396', charcoal: '#3E4348', black: '#22252A', white: '#EDEBE6', cream: '#E8DFC8',
beige: '#D9C9AC', brown: '#7A5538', tan: '#B88F62', oak: '#C69C6D', walnut: '#5C3D2A', green: '#5E7F63',
sage: '#8A9A8B', navy: '#2F4468', blue: '#4D74A8', teal: '#2F7F82', red: '#A8412E', terracotta: '#B8603F',
mustard: '#D4A12E', yellow: '#D9B84A', pink: '#D49CA6', orange: '#D2763A', rust: '#A5532D'
};
var MATERIALS = {
oak: 'Oak', walnut: 'Walnut', pine: 'Pine', birch: 'Birch', wood: 'Wood', velvet: 'Velvet', linen: 'Linen', boucle: 'Bouclé',
leather: 'Leather', fabric: 'Fabric', steel: 'Steel', metal: 'Metal', glass: 'Glass', marble: 'Marble', rattan: 'Rattan',
cane: 'Cane', wool: 'Wool'
};
var MAT_COLOUR = { oak: 'oak', walnut: 'walnut' };
var SIZE_WORDS = [
{ re: /super ?king/, w: 180, d: 205 }, { re: /\bking\b/, w: 150, d: 205 }, { re: /\bdouble\b/, w: 135, d: 195 },
{ re: /\bsingle\b/, w: 90, d: 195 }
];

function createFurnitureFallback(raw) {
var s = raw.trim();
if (!s) return null;
if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
var u;
try { u = new URL(s); } catch (e) { return null; }
if (u.hostname.indexOf('.') < 0) return null;
var host = u.hostname.replace(/^www\./, '').split('.');
var retailer = cap(host[0]);
var path = decodeURIComponent(u.pathname).toLowerCase();
var tokens = path.split(/[^a-z0-9£]+/).filter(Boolean);
var joined = tokens.join(' ');

var cat = null;
for (var i = 0; i < CATS.length; i++) { if (CATS[i].re.test(joined)) { cat = CATS[i]; break; } }
var base = cat || { id: 'generic', label: 'Furniture', w: 80, d: 60, h: 80, price: [60, 300], color: '#9A9A94', mat: 'Wood' };
var prov = { size: 'estimated', colour: 'estimated', material: 'estimated', price: 'estimated' };

var w = base.w, d = base.d, h = base.h;

/* size words, then explicit sizes from the link */
var seat = joined.match(/(\d)\s?seater/);
if (seat && base.id === 'sofa') { var sw = { 1: 95, 2: 160, 3: 210, 4: 250 }[seat[1]]; if (sw) { w = sw; prov.size = 'link'; } }
if (base.id === 'bed') {
    for (var k = 0; k < SIZE_WORDS.length; k++) { if (SIZE_WORDS[k].re.test(joined)) { w = SIZE_WORDS[k].w; d = SIZE_WORDS[k].d; prov.size = 'link'; break; } }
}
var dm = path.match(/(\d{2,3})\s?[x×]\s?(\d{2,3})(?:\s?[x×]\s?(\d{2,3}))?/);
if (dm) {
    w = +dm[1]; d = +dm[2]; if (dm[3]) h = +dm[3]; prov.size = 'link';
}

/* colour and material */
var colour = base.color, found = [];
var colourWord = null, matWord = null;
tokens.forEach(function (t) {
    if (!colourWord && COLOURS[t] && !MAT_COLOUR[t]) colourWord = t;
    if (MATERIALS[t] && found.indexOf(MATERIALS[t]) < 0) found.push(MATERIALS[t]);
    if (!matWord && MATERIALS[t]) matWord = t;
});
if (colourWord) { colour = COLOURS[colourWord]; prov.colour = 'link'; }
else if (matWord && MAT_COLOUR[matWord]) { colour = COLOURS[MAT_COLOUR[matWord]]; prov.colour = 'link'; }
var material = base.mat;
if (found.length) { material = found.slice(0, 2).join(' / '); prov.material = 'link'; }

/* shape */
var shape = 'rect';
if (/round|circular|oval/.test(joined) && ['coffee', 'dining', 'rug', 'armchair'].indexOf(base.id) >= 0) shape = 'round';
if (base.id === 'lamp' || base.id === 'plant') shape = 'round';
if (/corner|l shaped|l shape|chaise/.test(joined) && (base.id === 'sofa' || base.id === 'desk')) shape = 'L';
if (shape === 'round') { d = w; }

/* price */
var price, pm = path.match(/(?:£|gbp|price)[-_ ]?(\d{2,5})/);
if (pm) { price = +pm[1]; prov.price = 'link'; }
else { var span = base.price[1] - base.price[0]; price = Math.round((base.price[0] + hash(path) % (span + 1)) / 5) * 5; }

/* name */
var nameToks = [];
for (var n = 0; n < tokens.length; n++) {
    var t = tokens[n];
    if (STOP[t] || /^\d{3,}$/.test(t) || /^\d+x\d+/.test(t) || /^£/.test(t)) continue;
    if (nameToks.length >= 2 && (COLOURS[t] || MATERIALS[t])) break;
    nameToks.push(t);
    if (nameToks.length >= 5) break;
}
var name = nameToks.length ? nameToks.map(cap).join(' ') : base.label;

return {
    id: uid++, name: name, cat: base.id, w: w, d: d, h: h, shape: shape, color: colour, material: material,
    price: price, x: room.w / 2, y: room.l / 2, elev: 0, rot: 0, url: s, retailer: retailer, prov: prov
};
}

function extractedColour(value) {
if (typeof value !== 'string') return null;
var hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
if (hex) {
    var code = hex[1];
    return '#' + (code.length === 3 ? code.split('').map(function (c) { return c + c; }).join('') : code);
}
var words = value.toLowerCase().match(/[a-z]+/g) || [];
for (var i = 0; i < words.length; i++) {
    if (COLOURS[words[i]]) return COLOURS[words[i]];
    if (MAT_COLOUR[words[i]]) return COLOURS[MAT_COLOUR[words[i]]];
}
return null;
}

function applyProductData(item, product) {
if (product.name) item.name = product.name;
if (product.image) item.image = product.image;
item.modelImage = product.pngImage || null;
var dimensions = [product.widthCm, product.depthCm, product.heightCm];
if (dimensions.every(function (value) { return Number.isFinite(value) && value >= 10 && value <= 500; })) {
    item.w = dimensions[0]; item.d = dimensions[1]; item.h = dimensions[2]; item.prov.size = 'link';
}
if (product.material) { item.material = product.material; item.prov.material = 'link'; }
var color = extractedColour(product.color);
if (color) { item.color = color; item.prov.colour = 'link'; }
if (Number.isFinite(product.price) && product.price >= 0 && (!product.priceCurrency || product.priceCurrency.toUpperCase() === 'GBP')) {
    item.price = product.price; item.prov.price = 'link';
}
return item;
}

function isIkeaHostname(hostname) {
var host = hostname.toLowerCase();
return host === 'ikea.com' || /\.ikea\.com$/.test(host);
}

async function extract(raw, adapters) {
var item = createFurnitureFallback(raw);
if (!item) return null;
if (!isIkeaHostname(new URL(item.url).hostname)) throw new Error('Room For Improvement currently accepts IKEA product links only.');
var product = await window.RoomfitProductExtractor.extractFurnitureProduct(raw, adapters);
return { item: applyProductData(item, product), imageColorError: product.imageColorError || null };
}

/* =====================================================
    MODULE 3. Room state, collisions, interaction
    ===================================================== */
function corners(it) {
var c = Math.cos(it.rot * DEG), s = Math.sin(it.rot * DEG), hw = it.w / 2, hd = it.d / 2;
return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(function (p) {
    return [it.x + p[0] * c - p[1] * s, it.y + p[0] * s + p[1] * c];
});
}
function satOverlap(A, B) {
var EPS = 0.5;
var polys = [A, B];
for (var pi = 0; pi < 2; pi++) {
    var P = polys[pi];
    for (var i = 0; i < 4; i++) {
    var p1 = P[i], p2 = P[(i + 1) % 4];
    var nx = p1[1] - p2[1], ny = p2[0] - p1[0], len = Math.hypot(nx, ny);
    nx /= len; ny /= len;
    var a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9, q, j;
    for (j = 0; j < 4; j++) { q = A[j][0] * nx + A[j][1] * ny; if (q < a0) a0 = q; if (q > a1) a1 = q; }
    for (j = 0; j < 4; j++) { q = B[j][0] * nx + B[j][1] * ny; if (q < b0) b0 = q; if (q > b1) b1 = q; }
    if (a1 <= b0 + EPS || b1 <= a0 + EPS) return false;
    }
}
return true;
}
function insideRoom(it, poly) {
var cs = corners(it), pts = [];
for (var i = 0; i < 4; i++) {
    var a = cs[i], b = cs[(i + 1) % 4];
    pts.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
}
for (var k = 0; k < pts.length; k++) {
    var dx = it.x - pts[k][0], dy = it.y - pts[k][1], dl = Math.hypot(dx, dy) || 1;
    var test = [pts[k][0] + dx / dl * 0.5, pts[k][1] + dy / dl * 0.5];
    if (!pointInPoly(test, poly)) return false;
}
var c = Math.cos(-it.rot * DEG), s = Math.sin(-it.rot * DEG);
for (var v = 0; v < poly.length; v++) {
    var px = poly[v][0] - it.x, py = poly[v][1] - it.y;
    var lx = px * c - py * s, ly = px * s + py * c;
    if (Math.abs(lx) < it.w / 2 - 0.5 && Math.abs(ly) < it.d / 2 - 0.5) return false;
}
return true;
}
function doorZone() {
var o = roomOpenings(room).door, wd = o.x1 - o.x0, dp = Math.min(90, room.l - 10);
return [[o.x0, o.y - dp], [o.x1, o.y - dp], [o.x1, o.y], [o.x0, o.y]];
}
function elevOf(it) { return Number.isFinite(it.elev) ? it.elev : 0; }
function heightsOverlap(a, b) {
return elevOf(a) < elevOf(b) + b.h && elevOf(b) < elevOf(a) + a.h;
}
function computeIssues() {
var poly = roomPoly(room), list = [], bad = {};
var doorZones = room.shape === 'custom'
    ? customDoorGeometries(poly).map(function (door) { return door.zone; })
    : [doorZone()];
items.forEach(function (a, i) {
    if (!insideRoom(a, poly)) { list.push(a.name + ' is outside the walls'); bad[a.id] = true; }
    if (elevOf(a) + a.h > room.h) { list.push(a.name + ' goes through the ceiling'); bad[a.id] = true; }
    if (a.cat === 'rug') return;
    for (var doorIndex = 0; doorIndex < doorZones.length && elevOf(a) < 205; doorIndex++) {
        if (satOverlap(corners(a), doorZones[doorIndex])) {
            list.push(a.name + ' blocks the door'); bad[a.id] = true; break;
        }
    }
    for (var j = i + 1; j < items.length; j++) {
    var b = items[j];
    if (b.cat === 'rug') continue;
    if (heightsOverlap(a, b) && satOverlap(corners(a), corners(b))) { list.push(a.name + ' overlaps ' + b.name); bad[a.id] = true; bad[b.id] = true; }
    }
});
return { list: list, bad: bad };
}
function getSel() { for (var i = 0; i < items.length; i++) if (items[i].id === selId) return items[i]; return null; }
function freeSpot(it) {
var step = 20, poly = roomPoly(room);
var doorZones = room.shape === 'custom'
    ? customDoorGeometries(poly).map(function (door) { return door.zone; })
    : [doorZone()];
for (var y = it.d / 2 + 10; y < room.l; y += step) {
    for (var x = it.w / 2 + 10; x < room.w; x += step) {
    var t = { x: x, y: y, w: it.w, d: it.d, rot: 0 };
    if (!insideRoom(t, poly)) continue;
    var ok = true;
    for (var i = 0; i < items.length && ok; i++) {
        if (items[i].cat === 'rug' || it.cat === 'rug') continue;
        if (satOverlap(corners(t), corners(items[i]))) ok = false;
    }
    for (var doorIndex = 0; doorIndex < doorZones.length && ok; doorIndex++) {
        if (satOverlap(corners(t), doorZones[doorIndex])) ok = false;
    }
    if (ok) return [x, y];
    }
}
return [room.w / 2, room.l / 2];
}

/* ---------- 2D plan ---------- */
var cv = $('#plan'), ctx = cv.getContext('2d');
var V = { W: 600, H: 420, sc: 1, ox: 0, oy: 0 };
function sizePlan() {
var box = $('#planBox'), w = box.clientWidth || 600;
var h = clamp(Math.round(w * 0.72), 320, 640);
var dpr = window.devicePixelRatio || 1;
cv.style.height = h + 'px';
cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
V.W = w; V.H = h; V.dpr = dpr;
var pad = 48;
V.sc = Math.min((w - pad * 2) / room.w, (h - pad * 2) / room.l);
V.ox = (w - room.w * V.sc) / 2; V.oy = (h - room.l * V.sc) / 2;
}
function sx(x) { return V.ox + x * V.sc; }
function sy(y) { return V.oy + y * V.sc; }
function zOrder() {
var rugs = items.filter(function (i) { return i.cat === 'rug' && i.id !== selId; });
var rest = items.filter(function (i) { return i.cat !== 'rug' && i.id !== selId; })
    .map(function (it, index) { return { it: it, index: index }; })
    .sort(function (a, b) { return elevOf(a.it) - elevOf(b.it) || a.index - b.index; })
    .map(function (entry) { return entry.it; });
var sel = getSel();
return rugs.concat(rest, sel ? [sel] : []);
}
function itemPath(it) {
/* local frame, origin at centre, in screen pixels */
var hw = it.w / 2 * V.sc, hd = it.d / 2 * V.sc;
ctx.beginPath();
if (it.shape === 'round') { ctx.ellipse(0, 0, hw, hd, 0, 0, Math.PI * 2); }
else if (it.shape === 'L') {
    var cw = it.w * 0.45 * V.sc, cd = it.d * 0.5 * V.sc;
    ctx.moveTo(-hw, -hd); ctx.lineTo(hw - cw, -hd); ctx.lineTo(hw - cw, -hd + cd);
    ctx.lineTo(hw, -hd + cd); ctx.lineTo(hw, hd); ctx.lineTo(-hw, hd); ctx.closePath();
} else { ctx.rect(-hw, -hd, hw * 2, hd * 2); }
}
function drawPlan() {
var poly = roomPoly(room), iss = computeIssues();
ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
ctx.clearRect(0, 0, V.W, V.H);
ctx.fillStyle = cssv('--surface'); ctx.fillRect(0, 0, V.W, V.H);

/* floor + grid */
ctx.save();
ctx.beginPath(); poly.forEach(function (p, i) { i ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1])); }); ctx.closePath();
ctx.fillStyle = ctx.createPattern(getFloorTextureTile(room.floorTexture), 'repeat') || cssv('--floor');
ctx.fill(); ctx.clip();
ctx.strokeStyle = cssv('--grid'); ctx.lineWidth = 1;
for (var gx = 0; gx <= room.w; gx += 50) { ctx.globalAlpha = gx % 100 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(sx(gx), sy(0)); ctx.lineTo(sx(gx), sy(room.l)); ctx.stroke(); }
for (var gy = 0; gy <= room.l; gy += 50) { ctx.globalAlpha = gy % 100 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(sx(0), sy(gy)); ctx.lineTo(sx(room.w), sy(gy)); ctx.stroke(); }
ctx.restore(); ctx.globalAlpha = 1;

/* walls */
ctx.beginPath(); poly.forEach(function (p, i) { i ? ctx.lineTo(sx(p[0]), sy(p[1])) : ctx.moveTo(sx(p[0]), sy(p[1])); }); ctx.closePath();
ctx.strokeStyle = room.wallColor; ctx.lineWidth = 6; ctx.lineJoin = 'miter'; ctx.stroke();

var detectedDoors = roomDoorGeometries(poly);
ctx.strokeStyle = ctx.createPattern(getFloorTextureTile(room.floorTexture), 'repeat') || cssv('--floor');
ctx.lineWidth = 8;
detectedDoors.forEach(function (door) {
    ctx.beginPath(); ctx.moveTo(sx(door.start[0]), sy(door.start[1])); ctx.lineTo(sx(door.end[0]), sy(door.end[1])); ctx.stroke();
    ctx.strokeStyle = cssv('--muted'); ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    door.arc.forEach(function (point, index) { index ? ctx.lineTo(sx(point[0]), sy(point[1])) : ctx.moveTo(sx(point[0]), sy(point[1])); });
    ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx(door.hinge[0]), sy(door.hinge[1]));
    ctx.lineTo(sx(door.swingEnd[0]), sy(door.swingEnd[1])); ctx.stroke();
    ctx.strokeStyle = ctx.createPattern(getFloorTextureTile(room.floorTexture), 'repeat') || cssv('--floor');
    ctx.lineWidth = 8;
});
var detectedWindows = roomWindowGeometries(poly);
detectedWindows.forEach(function (windowItem) {
    var a = poly[windowItem.edgeIndex], b = poly[(windowItem.edgeIndex + 1) % poly.length];
    var dx = b[0] - a[0], dy = b[1] - a[1], edgeLength = Math.hypot(dx, dy) || 1;
    var inward = polyArea(poly) >= 0 ? [-dy / edgeLength, dx / edgeLength] : [dy / edgeLength, -dx / edgeLength];
    var offset = 3;
    ctx.strokeStyle = ctx.createPattern(getFloorTextureTile(room.floorTexture), 'repeat') || cssv('--floor');
    ctx.lineWidth = 8; ctx.beginPath();
    ctx.moveTo(sx(windowItem.start[0]), sy(windowItem.start[1]));
    ctx.lineTo(sx(windowItem.end[0]), sy(windowItem.end[1]));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(112, 203, 218, 0.3)'; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sx(windowItem.start[0]), sy(windowItem.start[1]));
    ctx.lineTo(sx(windowItem.end[0]), sy(windowItem.end[1]));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(130, 205, 217, 0.85)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx(windowItem.start[0] + inward[0] * offset), sy(windowItem.start[1] + inward[1] * offset));
    ctx.lineTo(sx(windowItem.end[0] + inward[0] * offset), sy(windowItem.end[1] + inward[1] * offset));
    ctx.stroke();
});

/* dimension labels */
ctx.fillStyle = cssv('--muted'); ctx.font = '500 12px ' + cssv('--font-mono'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
ctx.fillText((room.w / 100).toFixed(2) + ' m', sx(room.w / 2), V.oy - 20);
ctx.save(); ctx.translate(V.ox - 22, sy(room.l / 2)); ctx.rotate(-Math.PI / 2); ctx.fillText((room.l / 100).toFixed(2) + ' m', 0, 0); ctx.restore();

/* furniture */
zOrder().forEach(function (it) {
    var bad = iss.bad[it.id], sel = it.id === selId;
    ctx.save();
    ctx.translate(sx(it.x), sy(it.y)); ctx.rotate(it.rot * DEG);
    itemPath(it);
    ctx.globalAlpha = it.cat === 'rug' ? 0.7 : 0.94; ctx.fillStyle = it.color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = bad ? 2.5 : 1.2; ctx.strokeStyle = bad ? cssv('--warn') : 'rgba(0,0,0,0.45)';
    if (bad) ctx.setLineDash([6, 3]);
    ctx.stroke(); ctx.setLineDash([]);
    /* front notch */
    var hd = it.d / 2 * V.sc, nw = Math.min(14, it.w / 2 * V.sc * 0.5);
    if (it.cat !== 'rug') {
    ctx.fillStyle = lum(it.color) > 150 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.moveTo(-nw, hd - 1); ctx.lineTo(nw, hd - 1); ctx.lineTo(0, hd - 1 - Math.min(8, hd * 0.5)); ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    /* label */
    var pw = it.w * V.sc, ph = it.d * V.sc;
    var fs = clamp(V.sc * 10, 10, 13);
    ctx.font = '600 ' + fs + 'px ' + cssv('--font-body');
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = lum(it.color) > 150 ? '#16201C' : '#FFFFFF';
    var label = it.name, maxw = Math.max(pw, ph) * 0.9;
    if (Math.min(pw, ph) >= 22 || it.cat === 'lamp') {
    while (label.length > 3 && ctx.measureText(label).width > maxw) label = label.slice(0, -2);
    if (label !== it.name) label += '…';
    if (Math.max(pw, ph) >= 44) {
        var vertical = ph > pw * 1.6;
        ctx.save(); ctx.translate(sx(it.x), sy(it.y));
        if (vertical) ctx.rotate(-Math.PI / 2);
        ctx.fillText(label, 0, -fs * 0.5);
        ctx.font = '400 ' + (fs - 1) + 'px ' + cssv('--font-mono');
        ctx.fillText(Math.round(it.w) + '×' + Math.round(it.d) + (elevOf(it) > 0 ? ' · ↑' + Math.round(elevOf(it)) : ''), 0, fs * 0.7);
        ctx.restore();
    }
    }

    if (sel) {
    ctx.save(); ctx.translate(sx(it.x), sy(it.y)); ctx.rotate(it.rot * DEG);
    ctx.strokeStyle = cssv('--accent'); ctx.lineWidth = 2.5;
    var hw2 = it.w / 2 * V.sc + 3, hd2 = it.d / 2 * V.sc + 3;
    ctx.strokeRect(-hw2, -hd2, hw2 * 2, hd2 * 2);
    ctx.fillStyle = cssv('--accent');
    [[-hw2, -hd2], [hw2, -hd2], [hw2, hd2], [-hw2, hd2]].forEach(function (c) { ctx.fillRect(c[0] - 3, c[1] - 3, 6, 6); });
    ctx.restore();
    }
});
}

function toRoom(ev) {
var r = cv.getBoundingClientRect();
return [(ev.clientX - r.left - V.ox) / V.sc, (ev.clientY - r.top - V.oy) / V.sc];
}
function hitItem(p) {
var order = zOrder().reverse();
var nonRug = order.filter(function (i) { return i.cat !== 'rug'; }), rugs = order.filter(function (i) { return i.cat === 'rug'; });
var sel = getSel(), cand = (sel && sel.cat !== 'rug' ? [sel] : []).concat(nonRug, rugs);
for (var i = 0; i < cand.length; i++) {
    var it = cand[i], c = Math.cos(-it.rot * DEG), s = Math.sin(-it.rot * DEG);
    var dx = p[0] - it.x, dy = p[1] - it.y, lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) <= it.w / 2 && Math.abs(ly) <= it.d / 2) return it;
}
return null;
}
var drag = null;
function snapV(v) { return $('#snap').checked ? Math.round(v / 5) * 5 : Math.round(v * 10) / 10; }
cv.addEventListener('pointerdown', function (ev) {
cv.focus({ preventScroll: true });
var p = toRoom(ev), it = hitItem(p);
if (it) {
    selId = it.id; drag = { id: it.id, dx: it.x - p[0], dy: it.y - p[1] };
    cv.setPointerCapture(ev.pointerId);
} else { selId = null; }
renderList(); fillEditor(); drawPlan();
});
cv.addEventListener('pointermove', function (ev) {
if (!drag) return;
var it = getSel(); if (!it) return;
var p = toRoom(ev);
it.x = clamp(snapV(p[0] + drag.dx), -50, room.w + 50);
it.y = clamp(snapV(p[1] + drag.dy), -50, room.l + 50);
moved();
});
function endDrag(ev) { if (drag) { drag = null; try { cv.releasePointerCapture(ev.pointerId); } catch (e) {} renderList(); } }
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('keydown', function (ev) {
var it = getSel(); if (!it) return;
var step = ev.shiftKey ? 25 : 5, handled = true;
if (ev.key === 'ArrowLeft') it.x -= step;
else if (ev.key === 'ArrowRight') it.x += step;
else if (ev.key === 'ArrowUp') it.y -= step;
else if (ev.key === 'ArrowDown') it.y += step;
else if (ev.key === 'PageUp' || ev.key === '+' || ev.key === '=') it.elev = clamp(elevOf(it) + step, 0, Math.max(0, room.h - it.h));
else if (ev.key === 'PageDown' || ev.key === '-' || ev.key === '_') it.elev = clamp(elevOf(it) - step, 0, Math.max(0, room.h - it.h));
else if (ev.key === 'r' || ev.key === 'R') it.rot = (it.rot + (ev.shiftKey ? 90 : 15)) % 360;
else if (ev.key === 'Delete' || ev.key === 'Backspace') { removeItem(it.id); ev.preventDefault(); return; }
else handled = false;
if (handled) { ev.preventDefault(); moved(); renderList(); fillEditor(true); }
});

/* ---------- UI: stats, list, editor ---------- */
function updateStats() {
var area = polyArea(roomPoly(room));
var foot = 0, cost = 0;
items.forEach(function (i) { if (i.cat !== 'rug') foot += i.w * i.d; cost += +i.price || 0; });
var iss = computeIssues();
$('#stArea').innerHTML = (area / 10000).toFixed(1) + ' <small>m²</small>';
$('#stCover').innerHTML = Math.round(foot / area * 100) + ' <small>%</small>';
$('#stCost').textContent = gbp(cost);
$('#stIssues').textContent = iss.list.length;
$('#stIssues').style.color = iss.list.length ? cssv('--warn') : cssv('--good');
var ul = $('#issues'); ul.innerHTML = '';
if (!items.length) return;
if (!iss.list.length) { var f = document.createElement('li'); f.className = 'fine'; f.textContent = 'Everything fits. Nothing overlaps, and the door stays clear.'; ul.appendChild(f); }
iss.list.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
}
function renderList() {
var ul = $('#itemList'); ul.innerHTML = '';
$('#itemEmpty').hidden = items.length > 0;
var iss = computeIssues();
items.forEach(function (it) {
    var li = document.createElement('li'); li.className = 'item'; li.tabIndex = 0;
    if (it.id === selId) li.setAttribute('aria-current', 'true');
    var thumb = document.createElement('span'); thumb.className = 'thumb'; thumb.setAttribute('aria-hidden', 'true');
    if (it.image) {
        var imageUrl;
        try {
            var parsedImage = new URL(it.image);
            if ((parsedImage.protocol === 'http:' || parsedImage.protocol === 'https:') && isIkeaHostname(parsedImage.hostname)) {
                imageUrl = parsedImage.href;
            }
        } catch (error) {
            imageUrl = null;
        }
        if (imageUrl) {
            var image = document.createElement('img');
            image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
            image.src = '/api/fetch-image?url=' + encodeURIComponent(imageUrl);
            image.addEventListener('error', function () { thumb.classList.add('unavailable'); image.remove(); });
            thumb.appendChild(image);
        }
    }
    var sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = it.color;
    var mid = document.createElement('div'); mid.style.minWidth = '0';
    var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = it.name;
    var meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = Math.round(it.w) + '×' + Math.round(it.d) + '×' + Math.round(it.h) + ' cm · ' + it.material;
    mid.appendChild(nm); mid.appendChild(meta);
    var pr = document.createElement('span'); pr.className = 'pr'; pr.textContent = gbp(it.price);
    var dot = document.createElement('span'); dot.className = 'dot' + (iss.bad[it.id] ? ' bad' : ''); dot.title = iss.bad[it.id] ? 'Has a problem' : 'Fits';
    li.appendChild(thumb); li.appendChild(sw); li.appendChild(mid); li.appendChild(pr); li.appendChild(dot);
    var pick = function () { selId = it.id; renderList(); fillEditor(); drawPlan(); };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    ul.appendChild(li);
});
}
var E = {
name: $('#ed-name'), mat: $('#ed-mat'), w: $('#ed-w'), d: $('#ed-d'), h: $('#ed-h'), price: $('#ed-price'),
color: $('#ed-color'), shape: $('#ed-shape'), rot: $('#ed-rot'), elev: $('#ed-elev')
};
function fillEditor(keepFocus) {
var it = getSel();
$('#editor').hidden = !it;
$('#edEmpty').hidden = !!it; $('#edBody').hidden = !it;
if (!it) return;
if (!keepFocus || document.activeElement === cv) {
    E.name.value = it.name; E.mat.value = it.material; E.w.value = Math.round(it.w); E.d.value = Math.round(it.d);
    E.h.value = Math.round(it.h); E.elev.value = Math.round(elevOf(it)); E.price.value = it.price; E.color.value = it.color; E.shape.value = it.shape;
}
E.rot.value = Math.round(it.rot); $('#rotVal').textContent = Math.round(it.rot) + '°';
var b = $('#badges'); b.innerHTML = '';
[['size', 'Size'], ['colour', 'Colour'], ['material', 'Material'], ['price', 'Price']].forEach(function (f) {
    var s = document.createElement('span'); var fromLink = it.prov[f[0]] === 'link';
    s.className = 'badge' + (fromLink ? ' link' : ''); s.textContent = f[1] + (fromLink ? ' read from link' : ' estimated');
    b.appendChild(s);
});
$('#edSrc').textContent = it.url ? it.retailer + ' · ' + it.url : it.retailer;
updateAIModelPanel(it);
}
function bindEditor() {
function upd(fn) { return function () { var it = getSel(); if (!it) return; fn(it); edited(); }; }
E.name.addEventListener('input', upd(function (it) { it.name = E.name.value || 'Piece'; }));
E.mat.addEventListener('input', upd(function (it) { it.material = E.mat.value; it.prov.material = 'estimated'; }));
E.w.addEventListener('input', upd(function (it) { var v = +E.w.value; if (v >= 10) { it.w = v; it.prov.size = 'estimated'; if (it.shape === 'round') { it.d = v; E.d.value = v; } } }));
E.d.addEventListener('input', upd(function (it) { var v = +E.d.value; if (v >= 10) { it.d = v; it.prov.size = 'estimated'; } }));
E.h.addEventListener('input', upd(function (it) { var v = +E.h.value; if (v >= 1) it.h = v; }));
E.elev.addEventListener('input', upd(function (it) { var v = +E.elev.value; if (Number.isFinite(v)) it.elev = clamp(v, 0, 400); }));
E.price.addEventListener('input', upd(function (it) { it.price = Math.max(0, +E.price.value || 0); it.prov.price = 'estimated'; }));
E.color.addEventListener('input', upd(function (it) { it.color = E.color.value; it.prov.colour = 'estimated'; }));
E.shape.addEventListener('change', upd(function (it) { it.shape = E.shape.value; if (it.shape === 'round') { it.d = it.w; E.d.value = Math.round(it.d); } }));
E.rot.addEventListener('input', upd(function (it) { it.rot = +E.rot.value; $('#rotVal').textContent = it.rot + '°'; }));
$('#rotL').addEventListener('click', upd(function (it) { it.rot = (it.rot + 270) % 360; E.rot.value = it.rot; $('#rotVal').textContent = it.rot + '°'; }));
$('#rotR').addEventListener('click', upd(function (it) { it.rot = (it.rot + 90) % 360; E.rot.value = it.rot; $('#rotVal').textContent = it.rot + '°'; }));
$('#delBtn').addEventListener('click', function () { var it = getSel(); if (it) removeItem(it.id); });
}

function isValidGeneratedModelUrl(value) {
return typeof value === 'string' && /^\/generated_models\/[A-Za-z0-9-]{8,100}\.glb$/.test(value);
}
function readModelApiResponse(response) {
return response.text().then(function (text) {
    var data;
    try { data = JSON.parse(text); }
    catch (error) {
        var preview = text.replace(/\s+/g, ' ').trim().slice(0, 120);
        throw new Error('TRELLIS returned an invalid response' + (preview ? ': ' + preview : '.'));
    }
    if (!response.ok) {
        var failure = new Error(data.error || data.detail || 'TRELLIS returned HTTP ' + response.status + '.');
        failure.status = response.status;
        throw failure;
    }
    return data;
});
}
function modelApiRequest(route, payload) {
return fetch('/api/trellis/' + route, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
}).then(readModelApiResponse);
}
function modelFileSlug(name) {
var slug = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
return slug || 'model';
}
function savedModelLabel(model) {
var stem = String(model.taskId || model.modelUrl.replace(/^.*\//, '').replace(/\.glb$/, ''));
// Older models are saved under the bare task ID, so they have no name to show.
if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) return null;
var named = /^(.+)-[0-9a-f]{8}$/i.exec(stem);
if (!named) return null;
var words = named[1].split('-').filter(Boolean);
return words.length ? words.map(cap).join(' ') : null;
}
function updateAIModelPanel(item) {
var button = $('#generateModelButton');
var status = $('#aiModelStatus');
var download = $('#downloadModelLink');
var select = $('#savedModelSelect');
var job = item && trellisState.activeJob && trellisState.activeJob.itemId === item.id
    ? trellisState.activeJob : null;
var modelUrl = item && isValidGeneratedModelUrl(item.modelUrl) ? item.modelUrl : '';
var roomError = item ? trellisState.roomErrors[item.id] : '';
var generationError = item ? trellisState.generationErrors[item.id] : '';

button.disabled = !item || !item.image || !trellisState.statusLoaded || !trellisState.configured ||
    !!trellisState.statusError || !!trellisState.activeJob;
button.textContent = modelUrl ? 'Generate another model' : 'Generate 3D model';
$('#savedModelControls').hidden = !item || trellisState.savedModels.length === 0;
$('#useSavedModelButton').disabled = !item || !select.value;
download.hidden = !modelUrl;
if (modelUrl) {
    download.href = modelUrl;
    download.setAttribute('download', (item ? modelFileSlug(item.name) : 'model') + '.glb');
}
status.classList.remove('error-text');

if (job) {
    status.textContent = job.pollingError || (job.progress
        ? 'Generating model… ' + job.progress + '%'
        : 'Generating model… this can take a few minutes.');
} else if (trellisState.activeJob) {
    status.textContent = 'A model is generating for another item. Wait for it to finish.';
} else if (modelUrl && roomError) {
    status.textContent = 'Model is attached, but could not load in 3D: ' + roomError;
    status.classList.add('error-text');
} else if (modelUrl) {
    status.textContent = 'Model attached. Open the 3D view to inspect it; drag there to orbit the room.';
} else if (!trellisState.statusLoaded) {
    status.textContent = 'Checking the TRELLIS GPU connection…';
} else if (trellisState.statusError) {
    status.textContent = trellisState.statusError;
    status.classList.add('error-text');
} else if (!trellisState.configured) {
    status.textContent = 'Start the TRELLIS GPU API and local bridge, then reload this page.';
} else if (!item || !item.image) {
    status.textContent = 'This furniture item has no product image to send.';
} else if (trellisState.savedModelsError) {
    status.textContent = 'Could not load saved models: ' + trellisState.savedModelsError;
    status.classList.add('error-text');
} else if (generationError) {
    status.textContent = generationError;
    status.classList.add('error-text');
} else {
    status.textContent = item.modelImage
        ? 'Generate a model from this item’s PNG product image.'
        : 'No PNG image was found for this item, so its product photo will be used.';
}
}
function loadSavedModels() {
return modelApiRequest('models').then(function (result) {
    var select = $('#savedModelSelect');
    var previous = select.value;
    trellisState.savedModels = Array.isArray(result.models)
        ? result.models.filter(function (model) {
            return model && isValidGeneratedModelUrl(model.modelUrl);
        })
        : [];
    select.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a saved GLB…';
    select.appendChild(placeholder);
    trellisState.savedModels.forEach(function (model) {
        var option = document.createElement('option');
        option.value = model.modelUrl;
        var label = savedModelLabel(model);
        option.textContent = (label ? label + ' · ' : '') + (Number.isFinite(model.createdAt)
            ? new Date(model.createdAt).toLocaleString()
            : 'Saved model') + (Number.isFinite(model.sizeBytes)
            ? ' · ' + (model.sizeBytes / (1024 * 1024)).toFixed(1) + ' MB'
            : '');
        select.appendChild(option);
    });
    select.value = trellisState.savedModels.some(function (model) {
        return model.modelUrl === previous;
    }) ? previous : '';
    var library = $('#libraryModelSelect'), libraryPrevious = library.value;
    library.innerHTML = '';
    Array.prototype.forEach.call(select.options, function (option) { library.appendChild(option.cloneNode(true)); });
    library.options[0].textContent = trellisState.savedModels.length ? 'Choose a generated model…' : 'No generated models yet';
    library.value = trellisState.savedModels.some(function (model) { return model.modelUrl === libraryPrevious; }) ? libraryPrevious : '';
    $('#addLibraryModel').disabled = !library.value;
    trellisState.savedModelsError = '';
}).catch(function (error) {
    trellisState.savedModels = [];
    trellisState.savedModelsError = error.message || 'Could not load saved models.';
    $('#libraryModelSelect').innerHTML = '<option value="">Generated models are unavailable right now</option>';
    $('#addLibraryModel').disabled = true;
}).then(function () {
    updateAIModelPanel(getSel());
});
}
function checkTrellisStatus() {
if (window.location.protocol === 'file:') {
    trellisState.statusError = 'Open Room For Improvement through `node server.js` to use the TRELLIS model API.';
    trellisState.statusLoaded = true;
    updateAIModelPanel(getSel());
    return;
}
modelApiRequest('status').then(function (result) {
    trellisState.configured = result.configured === true;
}).catch(function (error) {
    trellisState.statusError = error.message || 'Could not connect to the TRELLIS service.';
}).then(function () {
    trellisState.statusLoaded = true;
    updateAIModelPanel(getSel());
});
}
function waitForModelPoll() {
return new Promise(function (resolve) { window.setTimeout(resolve, 2000); });
}
function pollModelTask(taskId, job, attempt, consecutiveFailures) {
if (attempt >= 900) return Promise.reject(new Error('TRELLIS generation is taking longer than expected. Check that the GPU server is still running.'));
return waitForModelPoll().then(function () {
    return modelApiRequest('tasks/' + encodeURIComponent(taskId));
}).then(function (task) {
    var taskStatus = typeof task.status === 'string' ? task.status.toUpperCase() : '';
    job.pollingError = '';
    job.progress = Number.isFinite(Number(task.progress)) ? Number(task.progress) : 0;
    updateAIModelPanel(getSel());
    if (taskStatus === 'SUCCEEDED') {
        if (!isValidGeneratedModelUrl(task.modelUrl)) throw new Error('TRELLIS completed without a valid generated model URL.');
        return task;
    }
    if (taskStatus === 'FAILED') throw new Error(task.error || 'TRELLIS could not generate a model from this image.');
    if (taskStatus && taskStatus !== 'PENDING' && taskStatus !== 'IN_PROGRESS') {
        throw new Error('TRELLIS returned an unexpected task status: ' + taskStatus + '.');
    }
    return pollModelTask(taskId, job, attempt + 1, 0);
}).catch(function (error) {
    if ((error.name === 'TypeError' || error.status >= 500) && consecutiveFailures < 3) {
        job.pollingError = 'Connection to TRELLIS was interrupted. Retrying (' + (consecutiveFailures + 1) + '/4)…';
        updateAIModelPanel(getSel());
        return pollModelTask(taskId, job, attempt + 1, consecutiveFailures + 1);
    }
    if (error.name === 'TypeError' || error.status >= 500) {
        throw new Error('Could not reconnect to TRELLIS after four attempts: ' + error.message);
    }
    throw error;
});
}
function generateSelectedModel() {
var item = getSel();
if (!item || !item.image || trellisState.activeJob || !trellisState.configured) return;
var job = { itemId: item.id, progress: 0, pollingError: '' };
trellisState.activeJob = job;
delete trellisState.generationErrors[item.id];
updateAIModelPanel(item);
modelApiRequest('generate', { imageUrl: item.modelImage || item.image, name: item.name }).then(function (created) {
    if (typeof created.taskId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(created.taskId)) {
        throw new Error('TRELLIS did not return a valid generation task.');
    }
    return pollModelTask(created.taskId, job, 0, 0);
}).then(function (task) {
    var currentItem = null;
    for (var i = 0; i < items.length; i++) {
        if (items[i].id === job.itemId) { currentItem = items[i]; break; }
    }
    if (!currentItem) {
        loadSavedModels();
        return;
    }
    currentItem.modelUrl = task.modelUrl;
    delete trellisState.generationErrors[item.id];
    delete trellisState.roomErrors[item.id];
    loadSavedModels();
    edited();
    fillEditor();
}).catch(function (error) {
    trellisState.generationErrors[item.id] = error.message || '3D model generation failed.';
    if (selId === item.id) updateAIModelPanel(getSel());
}).then(function () {
    if (trellisState.activeJob === job) trellisState.activeJob = null;
    updateAIModelPanel(getSel());
});
}
function useSavedModelInRoom() {
var item = getSel(), selectedUrl = $('#savedModelSelect').value;
if (!item || !isValidGeneratedModelUrl(selectedUrl) ||
    !trellisState.savedModels.some(function (model) { return model.modelUrl === selectedUrl; })) return;
item.modelUrl = selectedUrl;
delete trellisState.generationErrors[item.id];
delete trellisState.roomErrors[item.id];
edited();
fillEditor();
}
$('#generateModelButton').addEventListener('click', generateSelectedModel);
function setLibraryStatus(message, isError) {
var status = $('#libraryStatus');
status.textContent = message || '';
status.classList.toggle('error-text', Boolean(isError));
}
function addLibraryModel() {
var url = $('#libraryModelSelect').value;
var model = trellisState.savedModels.filter(function (m) { return m.modelUrl === url; })[0];
if (!model) return;
var it = {
    id: uid++, name: savedModelLabel(model) || 'Generated model', cat: 'generic',
    w: 80, d: 80, h: 80, shape: 'rect', color: '#9A9A94', material: 'Generated model', price: 0,
    x: room.w / 2, y: room.l / 2, elev: 0, rot: 0, url: '', retailer: 'Generated model',
    image: null, modelImage: null, modelUrl: url,
    prov: { size: 'estimated', colour: 'estimated', material: 'estimated', price: 'estimated' }
};
var spot = freeSpot(it); it.x = spot[0]; it.y = spot[1];
items.push(it); selId = it.id;
edited(); fillEditor();
setLibraryStatus('Added ' + it.name + '. Measuring the model…');
// Size the piece from the model's own proportions: 80 cm across its widest side.
getModelGltf(url).then(function (gltf) {
    var size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
    var widest = Math.max(size.x, size.z);
    if (!(widest > 1e-6) || !(size.y > 1e-6)) throw new Error('The model has no usable size.');
    if (items.indexOf(it) < 0) return;
    var scale = 80 / widest;
    it.w = clamp(Math.round(size.x * scale), 10, 500);
    it.d = clamp(Math.round(size.z * scale), 10, 500);
    it.h = clamp(Math.round(size.y * scale), 1, 300);
    var spot2 = freeSpot(it); it.x = spot2[0]; it.y = spot2[1];
    edited(); if (selId === it.id) fillEditor();
    setLibraryStatus('Added ' + it.name + '. Set its real size under Selected piece.');
}).catch(function () {
    setLibraryStatus('Added ' + it.name + ' at 80 × 80 × 80 cm. Set its real size under Selected piece.');
});
}
$('#libraryModelSelect').addEventListener('change', function () { $('#addLibraryModel').disabled = !this.value; });
$('#addLibraryModel').addEventListener('click', addLibraryModel);
$('#savedModelSelect').addEventListener('change', function () { updateAIModelPanel(getSel()); });
$('#useSavedModelButton').addEventListener('click', useSavedModelInRoom);
checkTrellisStatus();
loadSavedModels();

function removeItem(id) {
items = items.filter(function (i) { return i.id !== id; });
if (selId === id) selId = null;
edited(); fillEditor();
}

var movePending = false;
function moved() {
if (movePending) return;
movePending = true;
window.requestAnimationFrame(function () {
    movePending = false;
    drawPlan(); updateStats(); renderList_light(); sync3D(); scheduleFurnitureSave();
});
}
function renderList_light() { /* keep list dots current while dragging */
var iss = computeIssues(), rows = document.querySelectorAll('#itemList .item');
rows.forEach(function (row, i) { var d = row.querySelector('.dot'); if (d && items[i]) d.className = 'dot' + (iss.bad[items[i].id] ? ' bad' : ''); });
}
function edited() { renderList(); drawPlan(); updateStats(); rebuild3D(); scheduleFurnitureSave(); }

/* Furniture is saved in this browser so it survives reloads and trips to the room designer. */
var FURNITURE_STORAGE_KEY = 'roomfit.furniture.v1';
var furniturePersistenceEnabled = false, furnitureSaveTimer = null;
function saveFurnitureNow() {
if (furnitureSaveTimer) { window.clearTimeout(furnitureSaveTimer); furnitureSaveTimer = null; }
if (!furniturePersistenceEnabled) return;
try {
    window.localStorage.setItem(FURNITURE_STORAGE_KEY, JSON.stringify({ version: 1, furniture: items }));
} catch (error) {
    console.error('Could not save furniture in this browser.', error);
}
}
function scheduleFurnitureSave() {
if (!furniturePersistenceEnabled) return;
if (furnitureSaveTimer) window.clearTimeout(furnitureSaveTimer);
furnitureSaveTimer = window.setTimeout(saveFurnitureNow, 300);
}
// Keep pieces reachable when the room gets smaller: pull their centres back inside the room's bounds.
function keepItemsInRoom() {
items.forEach(function (it) {
    it.x = clamp(it.x, 0, room.w);
    it.y = clamp(it.y, 0, room.l);
    it.elev = clamp(Number.isFinite(it.elev) ? it.elev : 0, 0, Math.max(0, room.h - it.h));
});
}
function restoreFurniture() {
var stored;
try { stored = JSON.parse(window.localStorage.getItem(FURNITURE_STORAGE_KEY) || 'null'); } catch (error) { stored = null; }
if (!stored || stored.version !== 1 || !Array.isArray(stored.furniture)) return 0;
var restored = stored.furniture.slice(0, 100).map(function (value) {
    return validateSavedFurniture(value, uid++);
}).filter(Boolean);
items = restored;
keepItemsInRoom();
return restored.length;
}
function roomChanged() {
var area = polyArea(roomPoly(room)) / 10000;
var shapeName = { rect: 'Rectangle', L: 'L-shape', bay: 'Bay', custom: 'Custom outline' }[room.shape] || 'Rectangle';
$('#roomSummary').textContent = shapeName + ' · ' + (room.w / 100).toFixed(1) + ' × ' + (room.l / 100).toFixed(1) + ' m, ' + (room.h / 100).toFixed(2) + ' m ceiling · ' + area.toFixed(1) + ' m² of floor';
keepItemsInRoom(); sizePlan(); edited(); persistRoomConfig();
}

/* ---------- room form ---------- */
function readRoom() {
var w = +$('#rw').value, l = +$('#rl').value, h = +$('#rh').value;
if (!(w >= 200 && w <= 1200 && l >= 200 && l <= 1200 && h >= 200 && h <= 400)) return;
room.w = w; room.l = l; room.h = h;
roomChanged();
}
function readWallColor() {
room.wallColor = $('#wallColor').value.toUpperCase();
drawPlan();
if (T.ready) rebuild3D();
persistRoomConfig();
}
function readWallTransparency() {
room.transparentWalls = $('#transparentWalls').checked;
if (T.ready) rebuild3D();
persistRoomConfig();
}
function readFloorTexture() {
room.floorTexture = $('#floorTexture').value;
drawPlan();
if (T.ready) rebuild3D();
persistRoomConfig();
}
['#rw', '#rl', '#rh'].forEach(function (s) { $(s).addEventListener('input', readRoom); });
$('#wallColor').addEventListener('input', readWallColor);
$('#transparentWalls').addEventListener('change', readWallTransparency);
$('#floorTexture').addEventListener('change', readFloorTexture);

/* ---------- link extraction UI ---------- */
function logLine(text, cls) { var li = document.createElement('li'); if (cls) li.className = cls; li.textContent = text; $('#log').appendChild(li); $('#log').scrollTop = 1e6; return li; }
function apiRequest(path, payload) {
return fetch(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
}).then(async function (response) {
    var responseText = await response.text();
    var body;
    try {
        body = JSON.parse(responseText);
    } catch (error) {
        var preview = responseText.replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!response.ok) throw new Error('Extraction server returned HTTP ' + response.status + (preview ? ': ' + preview : '.'));
        throw new Error('Extraction server returned a non-JSON response' + (preview ? ': ' + preview : '.'));
    }
    if (!response.ok) throw new Error(body.error || 'The extraction service returned HTTP ' + response.status + '.');
    return body;
});
}
var busy = false;
$('#extractBtn').addEventListener('click', async function () {
if (busy) return;
var lines = $('#links').value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
$('#log').innerHTML = '';
if (!lines.length) { logLine('Paste at least one furniture link first.', 'err'); return; }
busy = true; this.disabled = true; this.textContent = 'Reading links…';
var added = 0;
var button = this;
try {
    if (!window.RoomfitProductExtractor) throw new Error('Product extractor did not load. Reload the page and try again.');
    if (window.location.protocol === 'file:') {
        throw new Error('Room For Improvement is opened as a local file. Start server.js and open http://127.0.0.1:3000 to use product extraction.');
    }
    var config = await apiRequest('/api/config');
    if (!config.pageFetcherConfigured) throw new Error('The IKEA page fetcher is unavailable. Restart the Room For Improvement server and try again.');
    var adapters = {
        fetchPage: function (url) { return apiRequest('/api/fetch-page', { url: url }); },
        fetchImage: async function (url) {
            var response = await fetch('/api/fetch-image?url=' + encodeURIComponent(url));
            if (!response.ok) {
                var body;
                try { body = await response.json(); } catch (error) { body = null; }
                throw new Error(body && body.error ? body.error : 'The IKEA image service returned HTTP ' + response.status + '.');
            }
            return response.blob();
        },
        extractStructured: config.llmConfigured
            ? function (input) { return apiRequest('/api/extract-structured', input); }
            : null
    };
    var running = 0, waiting = [];
    function limited(task) {
        return new Promise(function (resolve, reject) {
            function start() {
                running++;
                Promise.resolve().then(task).then(resolve, reject).then(function () {
                    running--;
                    if (waiting.length) waiting.shift()();
                });
            }
            if (running < 3) start(); else waiting.push(start);
        });
    }
    var pending = lines.map(function (line) {
        var promise = limited(function () { return extract(line, adapters); });
        promise.catch(function () {});
        return promise;
    });
    for (var i = 0; i < lines.length; i++) {
        var short = lines[i].replace(/^https?:\/\//, '').slice(0, 48);
        logLine('Reading ' + short + '…');
        try {
            var extraction = await pending[i];
            if (!extraction) throw new Error('Enter a valid product URL.');
            var it = extraction.item;
            var spot = freeSpot(it); it.x = spot[0]; it.y = spot[1];
            items.push(it); selId = it.id; added++;
            logLine('Added ' + it.name + ' · ' + Math.round(it.w) + '×' + Math.round(it.d) + '×' + Math.round(it.h) + ' cm · ' + it.material + ' · ' + gbp(it.price), 'ok');
            if (extraction.imageColorError) logLine('Image colour was not detected; using the available colour fallback. ' + extraction.imageColorError, 'err');
            edited(); fillEditor();
        } catch (error) {
            logLine('Could not extract "' + short + '": ' + error.message, 'err');
        }
    }
    if (added) $('#links').value = '';
} catch (error) {
    logLine(error.message, 'err');
} finally {
    busy = false; button.disabled = false; button.textContent = 'Extract details';
}
});

/* ---------- initial room ---------- */
function resetRoom() {
uid = 1; items = []; selId = null;
var defaultWallColor = cssv('--wall') || '#2B3A35';
room = { shape: 'rect', customPoly: null, customDoors: [], customWindows: [], w: 420, l: 360, h: 250, wallColor: defaultWallColor, transparentWalls: true, floorTexture: 'wood' };
$('#rw').value = 420; $('#rl').value = 360; $('#rh').value = 250;
$('#wallColor').value = defaultWallColor.toUpperCase();
$('#transparentWalls').checked = true;
$('#floorTexture').value = 'wood';
roomChanged(); fillEditor();
}
function applyImportedRoom() {
var params = new URLSearchParams(window.location.search);
var width = Number(params.get('roomWidth')), length = Number(params.get('roomLength'));
var height = Number(params.get('roomHeight'));
if (!(width >= 200 && width <= 1200 && length >= 200 && length <= 1200 &&
    height >= 200 && height <= 400)) return false;
var requestedShape = params.get('roomShape');
var customPoly = requestedShape === 'custom' ? parseImportedPolygon(params.get('roomPoly')) : null;
var invalidCustomPoly = requestedShape === 'custom' && !customPoly;
var doorParam = params.get('roomDoors');
var customDoors = customPoly ? parseImportedDoors(doorParam, customPoly) : [];
var invalidDoorData = !!doorParam && !!customPoly && !customDoors;
var windowParam = params.get('roomWindows');
var parsedWindows = customPoly ? parseImportedWindows(windowParam, customPoly, height) : [];
var invalidWindowData = !!windowParam && !!customPoly && !parsedWindows;
if (parsedWindows && customDoors && parsedWindows.some(function (windowItem) {
    return customDoors.some(function (door) {
        return door.edgeIndex === windowItem.edgeIndex &&
            door.t0 < windowItem.t1 && windowItem.t0 < door.t1;
    });
})) invalidWindowData = true;
var customWindows = invalidWindowData ? [] : parsedWindows || [];
var shape = customPoly ? 'custom' : requestedShape;
if (shape !== 'L' && shape !== 'bay' && shape !== 'custom') shape = 'rect';
room.w = width; room.l = length; room.h = height; room.shape = shape;
room.customPoly = customPoly; room.customDoors = customDoors || []; room.customWindows = customWindows;
$('#rw').value = width; $('#rl').value = length; $('#rh').value = height;
roomChanged();
if (invalidCustomPoly) $('#roomSummary').textContent += ' · the imported outline was invalid; using a rectangle instead.';
if (invalidDoorData) $('#roomSummary').textContent += ' · detected door data was invalid and has been ignored.';
if (invalidWindowData) $('#roomSummary').textContent += ' · window data was invalid and has been ignored.';
return true;
}
function parseImportedPolygon(value) {
if (typeof value !== 'string' || value.length > 12000) return null;
var poly;
try { poly = JSON.parse(value); } catch (error) { return null; }
if (!Array.isArray(poly) || poly.length < 3 || poly.length > 100) return null;
for (var pointIndex = 0; pointIndex < poly.length; pointIndex++) {
    var candidate = poly[pointIndex];
    if (!Array.isArray(candidate) || candidate.length !== 2 ||
        !Number.isFinite(candidate[0]) || !Number.isFinite(candidate[1]) ||
        candidate[0] < 0 || candidate[0] > 1 || candidate[1] < 0 || candidate[1] > 1) return null;
}
var area = 0;
for (var i = 0; i < poly.length; i++) {
    var point = poly[i], next = poly[(i + 1) % poly.length];
    area += point[0] * next[1] - next[0] * point[1];
}
return Math.abs(area) > 0.02 ? poly : null;
}
function parseImportedDoors(value, poly) {
if (!value) return [];
if (typeof value !== 'string' || value.length > 4000) return null;
var doors;
try { doors = JSON.parse(value); } catch (error) { return null; }
if (!Array.isArray(doors) || doors.length > 12) return null;
for (var i = 0; i < doors.length; i++) {
    var door = doors[i];
    if (!door || !Number.isInteger(door.edgeIndex) || door.edgeIndex < 0 || door.edgeIndex >= poly.length ||
        !Number.isFinite(door.t0) || !Number.isFinite(door.t1) ||
        door.t0 < 0 || door.t1 > 1 || door.t1 - door.t0 < 0.02 ||
        typeof door.hingeAtStart !== 'boolean' || typeof door.swingInward !== 'boolean' ||
        !Number.isFinite(door.confidence) || door.confidence < 0 || door.confidence > 1) return null;
}
return doors;
}
function parseImportedWindows(value, poly, roomHeight) {
if (!value) return [];
if (typeof value !== 'string' || value.length > 4000) return null;
var windows;
try { windows = JSON.parse(value); } catch (error) { return null; }
if (!Array.isArray(windows) || windows.length > 12) return null;
for (var i = 0; i < windows.length; i++) {
    var windowItem = windows[i];
    if (!windowItem || !Number.isInteger(windowItem.edgeIndex) ||
        windowItem.edgeIndex < 0 || windowItem.edgeIndex >= poly.length ||
        !Number.isFinite(windowItem.t0) || !Number.isFinite(windowItem.t1) ||
        windowItem.t0 < 0 || windowItem.t1 > 1 || windowItem.t1 - windowItem.t0 < 0.02 ||
        !Number.isFinite(windowItem.sillHeightCm) || windowItem.sillHeightCm < 0 ||
        !Number.isFinite(windowItem.heightCm) || windowItem.heightCm < 40 ||
        windowItem.sillHeightCm + windowItem.heightCm > roomHeight ||
        !Number.isFinite(windowItem.confidence) || windowItem.confidence < 0 || windowItem.confidence > 1) return null;
}
for (var i = 0; i < windows.length; i++) {
    var windowItem = windows[i];
    for (var other = i + 1; other < windows.length; other++) {
        var otherWindow = windows[other];
        if (windowItem.edgeIndex === otherWindow.edgeIndex &&
            windowItem.t0 < otherWindow.t1 && otherWindow.t0 < windowItem.t1) return null;
    }
}
return windows;
}
function segmentInterval(poly, start, end) {
for (var edgeIndex = 0; edgeIndex < poly.length; edgeIndex++) {
    var a = poly[edgeIndex], b = poly[(edgeIndex + 1) % poly.length];
    var dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1) continue;
    var startT = ((start[0] - a[0]) * dx + (start[1] - a[1]) * dy) / lengthSquared;
    var endT = ((end[0] - a[0]) * dx + (end[1] - a[1]) * dy) / lengthSquared;
    var startX = a[0] + dx * startT, startY = a[1] + dy * startT;
    var endX = a[0] + dx * endT, endY = a[1] + dy * endT;
    var tolerance = 1.5;
    if (Math.hypot(startX - start[0], startY - start[1]) > tolerance ||
        Math.hypot(endX - end[0], endY - end[1]) > tolerance ||
        startT < 0 || startT > 1 || endT < 0 || endT > 1) continue;
    return { edgeIndex: edgeIndex, t0: Math.min(startT, endT), t1: Math.max(startT, endT) };
}
return null;
}
function roomConfigSnapshot() {
var polygonCm = roomPoly(room);
var polygon = polygonCm.map(function (point) { return [point[0] / room.w, point[1] / room.l]; });
var doors = room.shape === 'custom' ? room.customDoors : [];
var windows = room.shape === 'custom' ? room.customWindows : [];
if (room.shape !== 'custom') {
    var preset = roomOpenings(room);
    var door = segmentInterval(polygonCm, [preset.door.x0, preset.door.y], [preset.door.x1, preset.door.y]);
    var windowOpening = segmentInterval(polygonCm, [preset.win.x0, preset.win.y], [preset.win.x1, preset.win.y]);
    if (door) doors = [Object.assign(door, { hingeAtStart: false, swingInward: true, confidence: 1 })];
    if (windowOpening) windows = [Object.assign(windowOpening, {
        sillHeightCm: 95,
        heightCm: Math.min(110, room.h - 95),
        confidence: 1
    })];
}
return {
    version: 1,
    shape: room.shape,
    widthCm: room.w,
    lengthCm: room.l,
    heightCm: room.h,
    polygon: polygon,
    doors: doors,
    windows: windows,
    wallColor: room.wallColor,
    transparentWalls: room.transparentWalls,
    floorTexture: room.floorTexture
};
}
function validatedRoomConfig(value) {
if (!value || typeof value !== 'object' || value.version !== 1 ||
    ['rect', 'L', 'bay', 'custom'].indexOf(value.shape) < 0 ||
    !Number.isFinite(value.widthCm) || value.widthCm < 200 || value.widthCm > 1200 ||
    !Number.isFinite(value.lengthCm) || value.lengthCm < 200 || value.lengthCm > 1200 ||
    !Number.isFinite(value.heightCm) || value.heightCm < 200 || value.heightCm > 400 ||
    !/^#[0-9a-f]{6}$/i.test(value.wallColor) ||
    typeof value.transparentWalls !== 'boolean' ||
    ['wood', 'carpet', 'marble'].indexOf(value.floorTexture) < 0 ||
    !Array.isArray(value.doors) || !Array.isArray(value.windows)) return null;
var polygon = parseImportedPolygon(JSON.stringify(value.polygon));
if (!polygon) return null;
var doors = parseImportedDoors(JSON.stringify(value.doors), polygon);
var windows = parseImportedWindows(JSON.stringify(value.windows), polygon, value.heightCm);
if (!doors || !windows || doors.some(function (door) {
    return doors.some(function (other) {
        return other !== door && other.edgeIndex === door.edgeIndex &&
            door.t0 < other.t1 && other.t0 < door.t1;
    }) || windows.some(function (windowItem) {
        return door.edgeIndex === windowItem.edgeIndex &&
            door.t0 < windowItem.t1 && windowItem.t0 < door.t1;
    });
})) return null;
return {
    version: 1,
    shape: value.shape,
    widthCm: value.widthCm,
    lengthCm: value.lengthCm,
    heightCm: value.heightCm,
    polygon: polygon,
    doors: doors,
    windows: windows,
    wallColor: value.wallColor.toUpperCase(),
    transparentWalls: value.transparentWalls,
    floorTexture: value.floorTexture
};
}
function applyRoomConfig(config) {
room.w = config.widthCm; room.l = config.lengthCm; room.h = config.heightCm;
room.shape = config.shape;
room.customPoly = config.shape === 'custom' ? config.polygon : null;
room.customDoors = config.shape === 'custom' ? config.doors : [];
room.customWindows = config.shape === 'custom' ? config.windows : [];
room.wallColor = config.wallColor;
room.transparentWalls = config.transparentWalls;
room.floorTexture = config.floorTexture;
$('#rw').value = room.w; $('#rl').value = room.l; $('#rh').value = room.h;
$('#wallColor').value = room.wallColor;
$('#transparentWalls').checked = room.transparentWalls;
$('#floorTexture').value = room.floorTexture;
roomChanged();
}
function setRoomStorageStatus(message) {
var status = $('#roomStorageStatus');
status.textContent = message || '';
status.hidden = !message;
}
function persistRoomConfig() {
if (!roomPersistenceEnabled || !window.RoomfitRoomStorage) return;
try {
    window.RoomfitRoomStorage.write(roomConfigSnapshot());
    setRoomStorageStatus('');
} catch (error) {
    console.error('Could not save room settings.', error);
    setRoomStorageStatus('Room settings could not be saved in this browser: ' + error.message);
}
}
function restoreRoomConfig() {
if (!window.RoomfitRoomStorage) return false;
try {
    var stored = window.RoomfitRoomStorage.read();
    if (!stored) return false;
    var config = validatedRoomConfig(stored);
    if (!config) {
        roomStorageRestoreFailed = true;
        setRoomStorageStatus('Saved room settings are invalid and were not loaded.');
        return false;
    }
    applyRoomConfig(config);
    return true;
} catch (error) {
    roomStorageRestoreFailed = true;
    console.error('Could not read saved room settings.', error);
    setRoomStorageStatus('Saved room settings could not be read: ' + error.message);
    return false;
}
}
function validateSavedFurniture(value, id) {
if (!value || typeof value !== 'object' ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 ||
    typeof value.material !== 'string' || value.material.length > 120 ||
    typeof value.cat !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(value.cat) ||
    ['rect', 'round', 'L'].indexOf(value.shape) < 0 ||
    !Number.isFinite(value.w) || value.w < 10 || value.w > 500 ||
    !Number.isFinite(value.d) || value.d < 10 || value.d > 500 ||
    !Number.isFinite(value.h) || value.h < 1 || value.h > 300 ||
    !Number.isFinite(value.price) || value.price < 0 || value.price > 20000 ||
    !Number.isFinite(value.x) || Math.abs(value.x) > 10000 ||
    !Number.isFinite(value.y) || Math.abs(value.y) > 10000 ||
    !Number.isFinite(value.rot) || Math.abs(value.rot) > 100000 ||
    (value.elev !== undefined && (!Number.isFinite(value.elev) || value.elev < 0 || value.elev > 400)) ||
    typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color) ||
    typeof value.url !== 'string' || value.url.length > 2048) return null;
var url = null;
if (value.url) {
    try { url = new URL(value.url); } catch (error) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
}
var image = null;
if (value.image) {
    try {
        var imageUrl = new URL(value.image);
        if ((imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') ||
            !isIkeaHostname(imageUrl.hostname)) return null;
        image = imageUrl.href;
    } catch (error) {
        return null;
    }
}
var modelImage = null;
if (value.modelImage) {
    try {
        var modelImageUrl = new URL(value.modelImage);
        if ((modelImageUrl.protocol === 'http:' || modelImageUrl.protocol === 'https:') &&
            isIkeaHostname(modelImageUrl.hostname)) modelImage = modelImageUrl.href;
    } catch (error) {
        modelImage = null;
    }
}
var modelUrl = null;
if (value.modelUrl !== undefined && value.modelUrl !== null) {
    if (!isValidGeneratedModelUrl(value.modelUrl)) return null;
    modelUrl = value.modelUrl;
}
var provenance = value.prov && typeof value.prov === 'object' ? value.prov : {};
function source(field) { return provenance[field] === 'link' ? 'link' : 'estimated'; }
return {
    id: id,
    name: value.name.trim(),
    cat: value.cat,
    w: value.w,
    d: value.d,
    h: value.h,
    shape: value.shape,
    color: value.color.toUpperCase(),
    material: value.material,
    price: value.price,
    x: value.x,
    y: value.y,
    elev: Number.isFinite(value.elev) ? value.elev : 0,
    rot: (value.rot % 360 + 360) % 360,
    url: url ? url.href : '',
    retailer: typeof value.retailer === 'string' ? value.retailer.slice(0, 100) : (url ? cap(url.hostname.split('.')[0]) : 'Generated model'),
    image: image,
    modelImage: modelImage,
    modelUrl: modelUrl,
    prov: { size: source('size'), colour: source('colour'), material: source('material'), price: source('price') }
};
}
function setDesignStatus(message, isError) {
var status = $('#designStatus');
status.textContent = message || '';
status.classList.toggle('error-text', Boolean(isError));
}
function saveDesignToFile() {
try {
    var name = $('#designName').value.trim().slice(0, 80) || 'Room For Improvement design';
    var design = {
        format: 'roomfit-design',
        version: 1,
        name: name,
        savedAt: new Date().toISOString(),
        room: roomConfigSnapshot(),
        furniture: items
    };
    var blob = new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    var filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'roomfit-design';
    var objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
    setDesignStatus('Saved ' + name + ' as a JSON file.');
} catch (error) {
    console.error('Could not save the design file.', error);
    setDesignStatus('The design file could not be saved: ' + error.message, true);
}
}
function loadDesignFile(file) {
if (!file) return;
if (file.size > 5 * 1024 * 1024) {
    setDesignStatus('Choose a design file smaller than 5 MB.', true);
    return;
}
var reader = new FileReader();
reader.onerror = function () {
    var message = reader.error ? reader.error.message : 'The file could not be read.';
    setDesignStatus(message, true);
};
reader.onload = function () {
    try {
        var text = String(reader.result || '').replace(/^\uFEFF/, '');
        var design = JSON.parse(text);
        if (!design || design.format !== 'roomfit-design' || design.version !== 1 ||
            !Array.isArray(design.furniture) || design.furniture.length > 100) {
            throw new Error('This is not a supported Room For Improvement design file.');
        }
        var config = validatedRoomConfig(design.room);
        if (!config) throw new Error('The saved room configuration is invalid.');
        var loadedItems = design.furniture.map(function (item, index) {
            return validateSavedFurniture(item, index + 1);
        });
        if (loadedItems.some(function (item) { return !item; })) {
            throw new Error('The design contains invalid furniture data.');
        }
        applyRoomConfig(config);
        items = loadedItems;
        uid = items.length + 1;
        selId = items.length ? items[0].id : null;
        if (typeof design.name === 'string' && design.name.trim()) $('#designName').value = design.name.slice(0, 80);
        edited();
        fillEditor();
        setDesignStatus('Loaded ' + $('#designName').value + '.');
    } catch (error) {
        console.error('Could not load the design file.', error);
        setDesignStatus('The design file could not be loaded: ' + error.message, true);
    } finally {
        $('#designFile').value = '';
    }
};
reader.readAsText(file);
}
$('#saveDesign').addEventListener('click', saveDesignToFile);
$('#loadDesign').addEventListener('click', function () { $('#designFile').click(); });
$('#designFile').addEventListener('change', function () { loadDesignFile(this.files && this.files[0]); });
$('#editRoomLink').addEventListener('click', function () { persistRoomConfig(); saveFurnitureNow(); });
window.addEventListener('pagehide', saveFurnitureNow);
$('#resetBtn').addEventListener('click', resetRoom);

/* =====================================================
    3D view (three.js)
    ===================================================== */
var T = { ready: false, groups: {}, root: null, ceilingLight: null, loader: null };
var orbit = { az: 0.75, pol: 1.0, dist: 700 };
function box3(g, w, h, d, x, y, z, color) {
var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: color }));
m.position.set(x, y + h / 2, z);
m.castShadow = true; m.receiveShadow = true;
m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 })));
g.add(m); return m;
}
function cyl3(g, rt, rb, h, x, y, z, color, extra) {
var mat = new THREE.MeshLambertMaterial({ color: color });
if (extra && extra.emissive) { mat.emissive = new THREE.Color(extra.emissive); }
var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 28), mat);
m.position.set(x, y + h / 2, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
}
function shade(hex, f) { var c = new THREE.Color(hex); c.multiplyScalar(f); return c; }
function build3DItem(it) {
var w = it.w, d = it.d, h = it.h;
var g = new THREE.Group(), col = new THREE.Color(it.color), dark = shade(it.color, 0.75), light = shade(it.color, 1.15);
var cat = it.cat, round = it.shape === 'round', L = it.shape === 'L';
if (cat === 'sofa' || cat === 'armchair') {
    if (L) {
    var cw = w * 0.45, cd = d * 0.5;
    box3(g, w - cw, h * 0.45, d, -cw / 2, 0, 0, col);
    box3(g, w, h * 0.45, d - cd, 0, 0, cd / 2, col);
    box3(g, w - cw, h, d * 0.22, -cw / 2, 0, -d / 2 + d * 0.11, col);
    box3(g, w * 0.08, h * 0.62, d, -w / 2 + w * 0.04, 0, 0, dark);
    } else {
    box3(g, w, h * 0.45, d * 0.94, 0, 0, d * 0.03, col);
    box3(g, w, h, d * 0.24, 0, 0, -d / 2 + d * 0.12, col);
    box3(g, w * 0.1, h * 0.62, d, -(w / 2 - w * 0.05), 0, 0, dark);
    box3(g, w * 0.1, h * 0.62, d, (w / 2 - w * 0.05), 0, 0, dark);
    box3(g, w * 0.76, h * 0.1, d * 0.6, 0, h * 0.45, d * 0.1, light);
    }
} else if (cat === 'bed') {
    box3(g, w, h * 0.28, d, 0, 0, 0, dark);
    box3(g, w * 0.96, h * 0.22, d * 0.94, 0, h * 0.28, d * 0.02, col);
    box3(g, w, h, d * 0.04, 0, 0, -d / 2 + d * 0.02, dark);
    box3(g, w * 0.38, h * 0.08, d * 0.14, -w * 0.22, h * 0.5, -d / 2 + d * 0.16, 0xF1EEE8);
    box3(g, w * 0.38, h * 0.08, d * 0.14, w * 0.22, h * 0.5, -d / 2 + d * 0.16, 0xF1EEE8);
} else if (cat === 'coffee' || cat === 'dining' || cat === 'desk') {
    var t = Math.max(3, h * 0.07);
    if (round) {
    cyl3(g, w / 2, w / 2, t, 0, h - t, 0, col);
    cyl3(g, w * 0.05, w * 0.12, h - t, 0, 0, 0, dark);
    } else {
    box3(g, w, t, d, 0, h - t, 0, col);
    var lx = w / 2 - 4, lz = d / 2 - 4;
    [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz]].forEach(function (p) { box3(g, 4, h - t, 4, p[0], 0, p[1], dark); });
    }
} else if (cat === 'chair') {
    box3(g, w, h * 0.07, d, 0, h * 0.46, 0, col);
    box3(g, w, h * 0.5, d * 0.1, 0, h * 0.5, -d / 2 + d * 0.05, col);
    var cx = w / 2 - 3, cz = d / 2 - 3;
    [[-cx, -cz], [cx, -cz], [-cx, cz], [cx, cz]].forEach(function (p) { box3(g, 3, h * 0.46, 3, p[0], 0, p[1], dark); });
} else if (cat === 'wardrobe') {
    box3(g, w, h, d, 0, 0, 0, col);
    box3(g, 1.5, h * 0.92, 1, 0, h * 0.04, d / 2 + 0.4, dark);
    box3(g, 3, 14, 2, -5, h * 0.45, d / 2 + 1, dark); box3(g, 3, 14, 2, 5, h * 0.45, d / 2 + 1, dark);
} else if (cat === 'bookcase') {
    box3(g, w, h, 2, 0, 0, -d / 2 + 1, dark);
    box3(g, 2, h, d, -(w / 2 - 1), 0, 0, col); box3(g, 2, h, d, w / 2 - 1, 0, 0, col);
    for (var s = 0; s < 5; s++) box3(g, w, 2, d, 0, s * (h - 2) / 4, 0, col);
} else if (cat === 'sideboard') {
    box3(g, w, h * 0.8, d, 0, h * 0.2, 0, col);
    var sx2 = w / 2 - 5, sz2 = d / 2 - 4;
    [[-sx2, -sz2], [sx2, -sz2], [-sx2, sz2], [sx2, sz2]].forEach(function (p) { box3(g, 4, h * 0.2, 4, p[0], 0, p[1], dark); });
    box3(g, 1.2, h * 0.7, 1, -w / 6, h * 0.25, d / 2 + 0.4, dark); box3(g, 1.2, h * 0.7, 1, w / 6, h * 0.25, d / 2 + 0.4, dark);
} else if (cat === 'lamp') {
    cyl3(g, w * 0.3, w * 0.3, 2, 0, 0, 0, col);
    cyl3(g, 1.2, 1.2, h * 0.84, 0, 0, 0, col);
    cyl3(g, w * 0.3, w * 0.46, h * 0.2, 0, h * 0.8, 0, 0xF4E9C8, { emissive: 0x5A4E2A });
} else if (cat === 'rug') {
    if (round) cyl3(g, w / 2, w / 2, 1.5, 0, 0, 0, col); else box3(g, w, 1.5, d, 0, 0, 0, col);
} else if (cat === 'plant') {
    cyl3(g, w * 0.28, w * 0.2, h * 0.28, 0, 0, 0, 0xB5A58F);
    var f = new THREE.Mesh(new THREE.SphereGeometry(w * 0.5, 16, 12), new THREE.MeshLambertMaterial({ color: col }));
    f.position.set(0, h * 0.28 + w * 0.45, 0); f.scale.set(1, 1.4, 1);
    f.castShadow = true; f.receiveShadow = true; g.add(f);
} else if (L) {
    var cw2 = w * 0.45, cd2 = d * 0.5;
    box3(g, w - cw2, h, d, -cw2 / 2, 0, 0, col); box3(g, w, h, d - cd2, 0, 0, cd2 / 2, col);
} else if (round) { cyl3(g, w / 2, w / 2, h, 0, 0, 0, col); }
else { box3(g, w, h, d, 0, 0, 0, col); }
return g;
}
function dispose3DObject(object) {
object.traverse(function (node) {
    if (node.userData && node.userData.sharedModel) return;
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
        var materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach(function (material) {
            if (material.map && !(material.map.userData && material.map.userData.shared)) material.map.dispose();
            material.dispose();
        });
    }
});
}
function getModelGltf(url) {
if (!threeModelCache[url]) {
    var loader = T.loader || (window.THREE && THREE.GLTFLoader ? new THREE.GLTFLoader() : null);
    if (!loader) return Promise.reject(new Error('The GLB loader did not load. Check the connection and reload.'));
    threeModelCache[url] = new Promise(function (resolve, reject) {
        loader.load(url, resolve, undefined, reject);
    }).catch(function (error) {
        delete threeModelCache[url];
        throw error;
    });
}
return threeModelCache[url];
}
function loadFurniture3DModel(item, group) {
var url = item.modelUrl;
if (!isValidGeneratedModelUrl(url)) return;
if (!T.loader) {
    trellisState.roomErrors[item.id] = 'The GLB loader did not load. Check the connection and reload.';
    if (selId === item.id) updateAIModelPanel(getSel());
    return;
}
getModelGltf(url).then(function (gltf) {
    var currentItem = null;
    for (var i = 0; i < items.length; i++) {
        if (items[i].id === item.id) { currentItem = items[i]; break; }
    }
    if (T.groups[item.id] !== group || !currentItem || currentItem.modelUrl !== url) return;

    var model = gltf.scene.clone(true);
    var bounds = new THREE.Box3().setFromObject(model);
    var size = bounds.getSize(new THREE.Vector3());
    if (![size.x, size.y, size.z].every(function (value) {
        return Number.isFinite(value) && value > 1e-5;
    })) throw new Error('The generated GLB has no usable 3D geometry.');
    var center = bounds.getCenter(new THREE.Vector3());
    var targetAspect = item.w / item.d;
    var modelAspect = size.x / size.z;
    var rotateToFit = Math.abs(Math.log((size.z / size.x) / targetAspect)) <
        Math.abs(Math.log(modelAspect / targetAspect));
    var centeredModel = new THREE.Group();
    centeredModel.position.set(-center.x, -bounds.min.y, -center.z);
    centeredModel.add(model);
    var orientedModel = new THREE.Group();
    orientedModel.rotation.y = rotateToFit ? Math.PI / 2 : 0;
    orientedModel.add(centeredModel);
    var orientedBounds = new THREE.Box3().setFromObject(orientedModel);
    var orientedSize = orientedBounds.getSize(new THREE.Vector3());
    var fitRoot = new THREE.Group();
    fitRoot.scale.set(item.w / orientedSize.x, item.h / orientedSize.y, item.d / orientedSize.z);
    fitRoot.add(orientedModel);
    var modelRoot = new THREE.Group();
    modelRoot.add(fitRoot);
    modelRoot.traverse(function (node) {
        node.userData = node.userData || {};
        node.userData.sharedModel = true;
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            fixGeneratedMaterial(node.material);
        }
    });
    clearGroup(group);
    group.add(modelRoot);
    delete trellisState.roomErrors[item.id];
    render3D();
    if (selId === item.id) updateAIModelPanel(getSel());
}).catch(function (error) {
    var currentItem = null;
    for (var i = 0; i < items.length; i++) {
        if (items[i].id === item.id) { currentItem = items[i]; break; }
    }
    if (T.groups[item.id] !== group || !currentItem || currentItem.modelUrl !== url) return;
    trellisState.roomErrors[item.id] = error.message || 'The generated GLB could not be loaded.';
    if (selId === item.id) updateAIModelPanel(getSel());
});
}
// TRELLIS GLBs leave metallicFactor unset, which glTF treats as fully metallic.
// With no environment map, metal reflects nothing and renders black, so make the
// surfaces non-metallic. The scene renders without sRGB output, so show the
// texture colours as stored instead of darkening them.
// TRELLIS textures already contain the shading from the product photo, so lighting them
// fully again makes them too dark. Show most of each texture's own colour (SELF_LIGHT)
// and let the room lights add a little shading on top (LIT). Raise SELF_LIGHT for
// brighter, flatter models; raise LIT for more shading.
var GENERATED_MODEL_SELF_LIGHT = 0.75;
var GENERATED_MODEL_LIT = 0.35;
function fixGeneratedMaterial(material) {
var materials = Array.isArray(material) ? material : [material];
materials.forEach(function (m) {
    if (!m || (m.userData && m.userData.roomfitFixed)) return;
    if ('metalness' in m) m.metalness = 0;
    if ('roughness' in m) m.roughness = Math.max(m.roughness, 0.8);
    if (m.map && m.map.encoding !== THREE.LinearEncoding) {
        m.map.encoding = THREE.LinearEncoding;
        m.map.needsUpdate = true;
    }
    if (m.map && m.emissive && m.color) {
        m.emissive.setRGB(1, 1, 1);
        m.emissiveMap = m.map;
        m.emissiveIntensity = GENERATED_MODEL_SELF_LIGHT;
        m.color.setRGB(GENERATED_MODEL_LIT, GENERATED_MODEL_LIT, GENERATED_MODEL_LIT);
    }
    m.userData = m.userData || {};
    m.userData.roomfitFixed = true;
    m.needsUpdate = true;
});
}
function clearGroup(g) {
while (g.children.length) {
    var c = g.children[0]; g.remove(c);
    dispose3DObject(c);
}
}
function init3D() {
if (T.ready) return true;
if (!window.THREE) { $('#three').innerHTML = '<div class="fallback">The 3D library could not load. Check your connection and reload the page. The floor plan still works.</div>'; return false; }
var el = $('#three');
T.renderer = new THREE.WebGLRenderer({ antialias: true });
T.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
T.renderer.shadowMap.enabled = true;
T.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
T.loader = window.THREE.GLTFLoader ? new THREE.GLTFLoader() : null;
el.appendChild(T.renderer.domElement);
T.scene = new THREE.Scene();
T.camera = new THREE.PerspectiveCamera(45, 1, 5, 6000);
T.scene.add(new THREE.HemisphereLight(0xfff7e8, 0x7d8988, 0.65));
T.ceilingLight = new THREE.PointLight(0xfff1dc, 1.1, 0, 2);
T.ceilingLight.castShadow = true;
T.ceilingLight.shadow.mapSize.set(512, 512);
T.ceilingLight.shadow.bias = -0.0005;
T.ceilingLight.shadow.normalBias = 0.02;
T.ceilingLight.shadow.radius = 3;
T.scene.add(T.ceilingLight);
T.root = new THREE.Group(); T.scene.add(T.root);
T.roomG = new THREE.Group(); T.itemsG = new THREE.Group(); T.root.add(T.roomG, T.itemsG);
var down = null;
var dom = T.renderer.domElement;
dom.addEventListener('pointerdown', function (e) { down = { x: e.clientX, y: e.clientY }; dom.setPointerCapture(e.pointerId); });
dom.addEventListener('pointermove', function (e) {
    if (!down) return;
    orbit.az -= (e.clientX - down.x) * 0.008; orbit.pol = clamp(orbit.pol - (e.clientY - down.y) * 0.006, 0.12, 1.5);
    down = { x: e.clientX, y: e.clientY }; render3D();
});
dom.addEventListener('pointerup', function () { down = null; });
dom.addEventListener('pointercancel', function () { down = null; });
dom.addEventListener('wheel', function (e) { e.preventDefault(); orbit.dist = clamp(orbit.dist * (1 + e.deltaY * 0.001), 200, 2600); render3D(); }, { passive: false });
T.ready = true;
return true;
}
function size3D() {
if (!T.ready) return;
var el = $('#three'), w = el.clientWidth || 600, h = clamp(Math.round(w * 0.62), 340, 600);
el.style.height = h + 'px';
T.renderer.setSize(w, h); T.camera.aspect = w / h; T.camera.updateProjectionMatrix();
}
var rebuild3DPending = false;
function rebuild3D() {
if (!T.ready) return;
if ($('#threeBox').hidden) { T.stale = true; return; }
if (rebuild3DPending) return;
rebuild3DPending = true;
window.requestAnimationFrame(function () {
    rebuild3DPending = false;
    rebuild3DNow();
});
}
function rebuild3DNow() {
if (!T.ready) return;
T.stale = false;
clearGroup(T.roomG); clearGroup(T.itemsG); T.groups = {};
var poly = roomPoly(room), cx = room.w / 2, cy = room.l / 2, H = room.h;
T.ceilingLight.position.set(0, H - 12, 0);
T.ceilingLight.distance = Math.max(room.w, room.l) * 3;
T.ceilingLight.shadow.camera.far = T.ceilingLight.distance;
T.ceilingLight.shadow.camera.updateProjectionMatrix();
/* floor */
var shp = new THREE.Shape(poly.map(function (p) { return new THREE.Vector2(p[0] - cx, -(p[1] - cy)); }));
var fg = new THREE.ShapeGeometry(shp); fg.rotateX(-Math.PI / 2);
var floor = new THREE.Mesh(fg, new THREE.MeshLambertMaterial({
    map: getThreeFloorTexture(room.floorTexture), side: THREE.DoubleSide
}));
floor.receiveShadow = true;
T.roomG.add(floor);
/* walls */
var wallCol = new THREE.Color(room.wallColor);
var detectedDoors = roomDoorGeometries(poly);
var detectedWindows = roomWindowGeometries(poly);
var doorwayHeight = Math.min(205, H - 10);
function addWallSegment(start, end, baseY, segmentHeight) {
    var dx = end[0] - start[0], dz = end[1] - start[1], len = Math.hypot(dx, dz);
    baseY = Number.isFinite(baseY) ? baseY : 0;
    segmentHeight = Number.isFinite(segmentHeight) ? segmentHeight : H;
    if (len < 0.1 || segmentHeight < 0.1) return;
    var ang = Math.atan2(dz, dx), wallOpacity = room.transparentWalls ? 0.22 : 1;
    var wm = new THREE.Mesh(new THREE.BoxGeometry(len, segmentHeight, 8), new THREE.MeshLambertMaterial({
        color: wallCol, transparent: room.transparentWalls, opacity: wallOpacity, depthWrite: !room.transparentWalls
    }));
    wm.castShadow = true; wm.receiveShadow = true;
    wm.position.set((start[0] + end[0]) / 2 - cx, baseY + segmentHeight / 2, (start[1] + end[1]) / 2 - cy); wm.rotation.y = -ang;
    wm.add(new THREE.LineSegments(new THREE.EdgesGeometry(wm.geometry), new THREE.LineBasicMaterial({
        color: wallCol, transparent: room.transparentWalls, opacity: room.transparentWalls ? 0.6 : 1
    })));
    T.roomG.add(wm);
}
for (var i = 0; i < poly.length; i++) {
    var a = poly[i], b = poly[(i + 1) % poly.length];
    var edgeOpenings = [];
    detectedDoors.forEach(function (door) {
        if (door.edgeIndex === i) edgeOpenings.push({ type: 'door', opening: door });
    });
    detectedWindows.forEach(function (windowItem) {
        if (windowItem.edgeIndex === i) edgeOpenings.push({ type: 'window', opening: windowItem });
    });
    edgeOpenings.sort(function (first, second) { return first.opening.t0 - second.opening.t0; });
    var cursor = 0;
    edgeOpenings.forEach(function (entry) {
        var opening = entry.opening;
        var start = Math.max(cursor, opening.t0), end = Math.max(start, Math.min(1, opening.t1));
        if (start > cursor) addWallSegment(
            [a[0] + (b[0] - a[0]) * cursor, a[1] + (b[1] - a[1]) * cursor],
            [a[0] + (b[0] - a[0]) * start, a[1] + (b[1] - a[1]) * start]
        );
        cursor = Math.max(cursor, end);
        if (entry.type === 'window') {
            var windowStart = [a[0] + (b[0] - a[0]) * start, a[1] + (b[1] - a[1]) * start];
            var windowEnd = [a[0] + (b[0] - a[0]) * end, a[1] + (b[1] - a[1]) * end];
            if (opening.sillHeightCm > 0) addWallSegment(windowStart, windowEnd, 0, opening.sillHeightCm);
            var aboveWindow = H - opening.sillHeightCm - opening.heightCm;
            if (aboveWindow > 0) addWallSegment(windowStart, windowEnd,
                opening.sillHeightCm + opening.heightCm, aboveWindow);
        } else if (doorwayHeight < H) {
            var doorStart = [a[0] + (b[0] - a[0]) * start, a[1] + (b[1] - a[1]) * start];
            var doorEnd = [a[0] + (b[0] - a[0]) * end, a[1] + (b[1] - a[1]) * end];
            addWallSegment(doorStart, doorEnd, doorwayHeight, H - doorwayHeight);
        }
    });
    if (cursor < 1) addWallSegment(
        [a[0] + (b[0] - a[0]) * cursor, a[1] + (b[1] - a[1]) * cursor],
        b
    );
}
detectedDoors.forEach(function (door) {
    var dx = door.swingEnd[0] - door.hinge[0], dz = door.swingEnd[1] - door.hinge[1];
    var length = Math.hypot(dx, dz);
    if (length < 1) return;
    var leaf = new THREE.Mesh(new THREE.BoxGeometry(length, doorwayHeight, 6), new THREE.MeshLambertMaterial({ color: 0xA9805A }));
    leaf.castShadow = true; leaf.receiveShadow = true;
    leaf.position.set((door.hinge[0] + door.swingEnd[0]) / 2 - cx, doorwayHeight / 2, (door.hinge[1] + door.swingEnd[1]) / 2 - cy);
    leaf.rotation.y = -Math.atan2(dz, dx);
    leaf.add(new THREE.LineSegments(new THREE.EdgesGeometry(leaf.geometry), new THREE.LineBasicMaterial({ color: 0x3E3026 })));
    T.roomG.add(leaf);
});
detectedWindows.forEach(function (windowItem) {
    var dx = windowItem.end[0] - windowItem.start[0], dz = windowItem.end[1] - windowItem.start[1];
    var length = Math.hypot(dx, dz);
    if (length < 1) return;
    var glassGroup = new THREE.Group();
    glassGroup.position.set(
        (windowItem.start[0] + windowItem.end[0]) / 2 - cx,
        windowItem.sillHeightCm + windowItem.heightCm / 2,
        (windowItem.start[1] + windowItem.end[1]) / 2 - cy
    );
    glassGroup.rotation.y = -Math.atan2(dz, dx);
    var glass = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1, length - 4), Math.max(1, windowItem.heightCm - 4), 2),
        new THREE.MeshLambertMaterial({
            color: 0xd7f3f6, transparent: true, opacity: 0.16,
            depthWrite: false, side: THREE.DoubleSide
        }));
    glass.castShadow = false; glass.receiveShadow = false;
    glassGroup.add(glass);
    var frameMaterial = new THREE.MeshLambertMaterial({ color: 0xc3cecf });
    var frameDepth = 6, frameSize = 3;
    var topFrame = new THREE.Mesh(new THREE.BoxGeometry(length, frameSize, frameDepth), frameMaterial);
    topFrame.position.y = windowItem.heightCm / 2 - frameSize / 2;
    var bottomFrame = new THREE.Mesh(new THREE.BoxGeometry(length, frameSize, frameDepth), frameMaterial);
    bottomFrame.position.y = -windowItem.heightCm / 2 + frameSize / 2;
    var leftFrame = new THREE.Mesh(new THREE.BoxGeometry(frameSize, windowItem.heightCm, frameDepth), frameMaterial);
    leftFrame.position.x = -length / 2 + frameSize / 2;
    var rightFrame = new THREE.Mesh(new THREE.BoxGeometry(frameSize, windowItem.heightCm, frameDepth), frameMaterial);
    rightFrame.position.x = length / 2 - frameSize / 2;
    [topFrame, bottomFrame, leftFrame, rightFrame].forEach(function (frame) {
        frame.castShadow = true; frame.receiveShadow = true;
    });
    glassGroup.add(topFrame, bottomFrame, leftFrame, rightFrame);
    T.roomG.add(glassGroup);
});
/* furniture */
items.forEach(function (it) {
    var g = build3DItem(it);
    T.itemsG.add(g);
    T.groups[it.id] = g;
    if (it.modelUrl) loadFurniture3DModel(it, g);
});
orbit.dist = clamp(Math.max(room.w, room.l) * 1.5, 450, 2200);
sync3D(true);
}

function sync3D(noRender) {
if (!T.ready) return;
var cx = room.w / 2, cy = room.l / 2;
items.forEach(function (it) {
    var g = T.groups[it.id]; if (!g) return;
    g.position.set(it.x - cx, elevOf(it), it.y - cy); g.rotation.y = -it.rot * DEG;
});
if (!noRender) render3D();
else render3D();
}
function render3D() {
if (!T.ready || $('#threeBox').hidden) return;
var bg = cssv('--surface'); T.scene.background = new THREE.Color(bg);
var tx = 0, ty = room.h * 0.15, tz = 0;
T.camera.position.set(tx + orbit.dist * Math.sin(orbit.pol) * Math.sin(orbit.az), ty + orbit.dist * Math.cos(orbit.pol), tz + orbit.dist * Math.sin(orbit.pol) * Math.cos(orbit.az));
T.camera.lookAt(tx, ty, tz);
T.renderer.render(T.scene, T.camera);
}

/* ---------- tabs ---------- */
function showTab(which) {
var plan = which === 'plan';
$('#planBox').hidden = !plan; $('#threeBox').hidden = plan;
$('#tab-plan').setAttribute('aria-selected', plan); $('#tab-3d').setAttribute('aria-selected', !plan);
$('#stageHint').textContent = plan
    ? 'Drag to arrange pieces; select one to edit.'
    : 'Drag to orbit the room; scroll to zoom.';
if (plan) { sizePlan(); drawPlan(); }
else if (init3D()) { size3D(); rebuild3D(); }
}
$('#tab-plan').addEventListener('click', function () { showTab('plan'); });
$('#tab-3d').addEventListener('click', function () { showTab('3d'); });

window.addEventListener('resize', function () { if (!$('#planBox').hidden) { sizePlan(); drawPlan(); } else { size3D(); render3D(); } });
if (window.matchMedia) {
var mq = window.matchMedia('(prefers-color-scheme: dark)');
var onTheme = function () { cssCache = {}; drawPlan(); updateStats(); if (T.ready) rebuild3D(); };
if (mq.addEventListener) mq.addEventListener('change', onTheme);
}
new MutationObserver(function () { cssCache = {}; drawPlan(); updateStats(); if (T.ready) rebuild3D(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ---------- boot ---------- */
bindEditor();
resetRoom();
var restoredRoom = restoreRoomConfig();
var importedRoom = applyImportedRoom();
roomPersistenceEnabled = true;
if (restoredRoom || importedRoom || !roomStorageRestoreFailed) persistRoomConfig();
if (restoreFurniture()) { selId = null; edited(); fillEditor(); }
furniturePersistenceEnabled = true;
if (window.ResizeObserver) new ResizeObserver(function () { if (!$('#planBox').hidden) { sizePlan(); drawPlan(); } }).observe($('#planBox'));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { drawPlan(); });
})();
