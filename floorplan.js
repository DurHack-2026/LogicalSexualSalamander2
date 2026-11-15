(function () {
'use strict';

var $ = function (selector) { return document.querySelector(selector); };
var svg = $('#roomEditor');
var drawing = $('#roomDrawing');
var poly = [[0, 0], [1, 0], [1, 1], [0, 1]];
var doors = [];
var windows = [];
var selectedVertex = 0;
var selectedDoor = -1;
var selectedWindow = -1;
var dragVertex = -1;
var mode = 'idle';
var SVG_NS = 'http://www.w3.org/2000/svg';
var MAX_CORNERS = 100;
var MAX_DOORS = 12;
var MAX_WINDOWS = 12;
var roomShape = 'custom';
var roomAppearance = { wallColor: '#2B3A35', transparentWalls: true, floorTexture: 'wood' };
var roomStorageReady = false;
var roomStorageTimer = null;

function roomWidth() { return Number($('#roomWidth').value); }
function roomLength() { return Number($('#roomLength').value); }
function roomHeight() { return Number($('#roomHeight').value); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function drawingBounds() {
    var width = roomWidth(), length = roomLength();
    var boxWidth = 704, boxHeight = 432;
    var aspect = Number.isFinite(width) && width > 0 && Number.isFinite(length) && length > 0
        ? width / length : 420 / 360;
    var drawWidth = Math.min(boxWidth, boxHeight * aspect);
    var drawHeight = drawWidth / aspect;
    return {
        x: (800 - drawWidth) / 2,
        y: (520 - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight
    };
}

function toScreen(point, bounds) {
    return [bounds.x + point[0] * bounds.width, bounds.y + point[1] * bounds.height];
}

function svgEventPoint(event) {
    var matrix = svg.getScreenCTM();
    if (!matrix) return null;
    var point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    var transformed = point.matrixTransform(matrix.inverse());
    return [transformed.x, transformed.y];
}

function toNormalized(point) {
    var bounds = drawingBounds();
    return [
        clamp((point[0] - bounds.x) / bounds.width, 0, 1),
        clamp((point[1] - bounds.y) / bounds.height, 0, 1)
    ];
}

function signedArea(points) {
    var area = 0;
    for (var i = 0; i < points.length; i++) {
        var next = points[(i + 1) % points.length];
        area += points[i][0] * next[1] - next[0] * points[i][1];
    }
    return area / 2;
}

function cross(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, point) {
    return point[0] >= Math.min(a[0], b[0]) - 1e-8 &&
        point[0] <= Math.max(a[0], b[0]) + 1e-8 &&
        point[1] >= Math.min(a[1], b[1]) - 1e-8 &&
        point[1] <= Math.max(a[1], b[1]) + 1e-8;
}

function segmentsIntersect(a, b, c, d) {
    var abC = cross(a, b, c), abD = cross(a, b, d);
    var cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (abC * abD < 0 && cdA * cdB < 0) return true;
    return Math.abs(abC) < 1e-8 && onSegment(a, b, c) ||
        Math.abs(abD) < 1e-8 && onSegment(a, b, d) ||
        Math.abs(cdA) < 1e-8 && onSegment(c, d, a) ||
        Math.abs(cdB) < 1e-8 && onSegment(c, d, b);
}

function validPolygon(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > MAX_CORNERS) return false;
    for (var i = 0; i < points.length; i++) {
        if (!Array.isArray(points[i]) || points[i].length !== 2 ||
            !Number.isFinite(points[i][0]) || !Number.isFinite(points[i][1]) ||
            points[i][0] < 0 || points[i][0] > 1 || points[i][1] < 0 || points[i][1] > 1) return false;
        var next = points[(i + 1) % points.length];
        if (Math.hypot(next[0] - points[i][0], next[1] - points[i][1]) < 0.005) return false;
    }
    if (Math.abs(signedArea(points)) <= 0.02) return false;

    for (var first = 0; first < points.length; first++) {
        var firstNext = (first + 1) % points.length;
        for (var second = first + 1; second < points.length; second++) {
            var secondNext = (second + 1) % points.length;
            if (first === second || firstNext === second || secondNext === first) continue;
            if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) return false;
        }
    }
    return true;
}

function edgeLengthCm(edgeIndex) {
    var a = poly[edgeIndex], b = poly[(edgeIndex + 1) % poly.length];
    return Math.hypot((b[0] - a[0]) * roomWidth(), (b[1] - a[1]) * roomLength());
}

function presetPolygon(shape) {
    var width = roomWidth(), length = roomLength();
    if (shape === 'L') {
        var cutWidth = Math.round(width * 0.4), cutLength = Math.round(length * 0.42);
        return [
            [0, 0], [(width - cutWidth) / width, 0],
            [(width - cutWidth) / width, cutLength / length], [1, cutLength / length],
            [1, 1], [0, 1]
        ];
    }
    if (shape === 'bay') {
        var bayDepth = Math.round(length * 0.16);
        var bayLeft = Math.round(width * 0.25), bayRight = Math.round(width * 0.75);
        return [
            [0, bayDepth / length], [bayLeft / width, bayDepth / length],
            [bayLeft / width, 0], [bayRight / width, 0],
            [bayRight / width, bayDepth / length], [1, bayDepth / length],
            [1, 1], [0, 1]
        ];
    }
    if (shape === 'rect') return [[0, 0], [1, 0], [1, 1], [0, 1]];
    return null;
}

function presetOpeningInterval(points, start, end) {
    var width = roomWidth(), length = roomLength();
    for (var i = 0; i < points.length; i++) {
        var a = [points[i][0] * width, points[i][1] * length];
        var b = [points[(i + 1) % points.length][0] * width,
            points[(i + 1) % points.length][1] * length];
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var lengthSquared = dx * dx + dy * dy;
        if (!lengthSquared) continue;

        function project(point) {
            var t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
            var nearest = [a[0] + dx * t, a[1] + dy * t];
            return { t: t, distance: Math.hypot(point[0] - nearest[0], point[1] - nearest[1]) };
        }

        var first = project(start), second = project(end);
        if (first.distance <= 1.5 && second.distance <= 1.5 &&
            first.t >= -1e-6 && first.t <= 1 + 1e-6 &&
            second.t >= -1e-6 && second.t <= 1 + 1e-6) {
            return { edgeIndex: i, t0: Math.min(first.t, second.t), t1: Math.max(first.t, second.t) };
        }
    }
    return null;
}

function applyPresetShape(shape) {
    var width = roomWidth(), length = roomLength(), height = roomHeight();
    if (!Number.isFinite(width) || width < 200 || width > 1200 ||
        !Number.isFinite(length) || length < 200 || length > 1200 ||
        !Number.isFinite(height) || height < 200 || height > 400) return false;
    var points = presetPolygon(shape);
    if (!points) return false;

    poly = points;
    roomShape = shape;
    var doorStart = 30, doorEnd = Math.min(120, width - 30);
    var doorInterval = presetOpeningInterval(poly, [doorStart, length], [doorEnd, length]);
    doors = doorInterval ? [Object.assign(doorInterval, {
        hingeAtStart: false,
        swingInward: true,
        confidence: 1,
        widthCm: doorEnd - doorStart,
        tooWide: false
    })] : [];

    var windowStart, windowEnd;
    if (shape === 'L') {
        var topWidth = Math.round(width - width * 0.4);
        var halfWidth = Math.min(70, topWidth / 2 - 20);
        windowStart = topWidth / 2 - halfWidth;
        windowEnd = topWidth / 2 + halfWidth;
    } else if (shape === 'bay') {
        var bayWindowWidth = Math.min(240, width / 2, Math.max(60, width * 0.2));
        windowStart = (width - bayWindowWidth) / 2;
        windowEnd = (width + bayWindowWidth) / 2;
    } else {
        var halfWindow = Math.min(120, width / 4);
        windowStart = width / 2 - halfWindow;
        windowEnd = width / 2 + halfWindow;
    }
    var windowInterval = presetOpeningInterval(poly, [windowStart, 0], [windowEnd, 0]);
    var sillHeight = 95, glassHeight = Math.min(110, height - sillHeight);
    windows = windowInterval ? [Object.assign(windowInterval, {
        widthCm: windowEnd - windowStart,
        sillHeightCm: sillHeight,
        heightCm: glassHeight,
        confidence: 1,
        invalid: false
    })] : [];

    $('#doorWidth').value = Math.round(doorEnd - doorStart);
    $('#windowWidth').value = Math.round(windowEnd - windowStart);
    $('#windowSill').value = sillHeight;
    $('#windowHeight').value = Math.round(glassHeight);
    return true;
}

function refreshDoorGeometry() {
    doors.forEach(function (door) {
        if (door.edgeIndex < 0 || door.edgeIndex >= poly.length) {
            door.tooWide = true;
            return;
        }
        var edgeLength = edgeLengthCm(door.edgeIndex);
        if (!Number.isFinite(edgeLength) || edgeLength <= 0 || !Number.isFinite(door.widthCm) ||
            !Number.isFinite(roomWidth()) || roomWidth() <= 0 ||
            !Number.isFinite(roomLength()) || roomLength() <= 0) {
            door.tooWide = true;
            return;
        }
        var fraction = door.widthCm / edgeLength;
        door.tooWide = fraction > 0.9;
        fraction = Math.min(0.9, fraction);
        var center = clamp((door.t0 + door.t1) / 2, fraction / 2, 1 - fraction / 2);
        door.t0 = center - fraction / 2;
        door.t1 = center + fraction / 2;
    });
}

function refreshWindowGeometry() {
    windows.forEach(function (windowItem) {
        if (windowItem.edgeIndex < 0 || windowItem.edgeIndex >= poly.length) {
            windowItem.invalid = true;
            return;
        }
        var edgeLength = edgeLengthCm(windowItem.edgeIndex);
        if (!Number.isFinite(edgeLength) || edgeLength <= 0 ||
            !Number.isFinite(windowItem.widthCm) || !Number.isFinite(roomWidth()) || roomWidth() <= 0 ||
            !Number.isFinite(roomLength()) || roomLength() <= 0) {
            windowItem.invalid = true;
            return;
        }
        var fraction = windowItem.widthCm / edgeLength;
        windowItem.invalid = fraction > 0.9 ||
            !Number.isFinite(windowItem.sillHeightCm) || windowItem.sillHeightCm < 0 ||
            !Number.isFinite(windowItem.heightCm) || windowItem.heightCm < 40 ||
            windowItem.sillHeightCm + windowItem.heightCm > roomHeight();
        fraction = Math.min(0.9, fraction);
        var center = clamp((windowItem.t0 + windowItem.t1) / 2, fraction / 2, 1 - fraction / 2);
        windowItem.t0 = center - fraction / 2;
        windowItem.t1 = center + fraction / 2;
    });
}

function validationError() {
    if (!validPolygon(poly)) return 'The outline needs 3–100 corners, a visible area, and no crossing or overlapping edges.';
    var width = roomWidth(), length = roomLength(), height = roomHeight();
    if (!Number.isFinite(width) || width < 200 || width > 1200 ||
        !Number.isFinite(length) || length < 200 || length > 1200) {
        return 'Enter room width and length between 200 and 1200 cm.';
    }
    if (!Number.isFinite(height) || height < 200 || height > 400) {
        return 'Enter a ceiling height between 200 and 400 cm.';
    }
    if (doors.length > MAX_DOORS) return 'A room can have at most 12 doors.';
    if (windows.length > MAX_WINDOWS) return 'A room can have at most 12 windows.';
    for (var i = 0; i < doors.length; i++) {
        var door = doors[i];
        if (door.tooWide || !Number.isInteger(door.edgeIndex) ||
            door.edgeIndex < 0 || door.edgeIndex >= poly.length ||
            !Number.isFinite(door.t0) || !Number.isFinite(door.t1) ||
            door.t0 < 0 || door.t1 > 1 || door.t1 - door.t0 < 0.02 ||
            !Number.isFinite(door.widthCm) || door.widthCm < 60 || door.widthCm > 140) {
            return 'A door no longer fits on its wall. Move or remove it, or reshape the wall.';
        }
        for (var other = i + 1; other < doors.length; other++) {
            if (door.edgeIndex === doors[other].edgeIndex &&
                door.t0 < doors[other].t1 && doors[other].t0 < door.t1) {
                return 'Door openings on the same wall cannot overlap.';
            }
        }
        if (windows.some(function (windowItem) {
            return door.edgeIndex === windowItem.edgeIndex &&
                door.t0 < windowItem.t1 && windowItem.t0 < door.t1;
        })) return 'A window and door cannot overlap on the same wall.';
    }
    for (var windowIndex = 0; windowIndex < windows.length; windowIndex++) {
        var currentWindow = windows[windowIndex];
        if (currentWindow.invalid || !Number.isInteger(currentWindow.edgeIndex) ||
            currentWindow.edgeIndex < 0 || currentWindow.edgeIndex >= poly.length ||
            !Number.isFinite(currentWindow.t0) || !Number.isFinite(currentWindow.t1) ||
            currentWindow.t0 < 0 || currentWindow.t1 > 1 || currentWindow.t1 - currentWindow.t0 < 0.02 ||
            !Number.isFinite(currentWindow.widthCm) || currentWindow.widthCm < 60 || currentWindow.widthCm > 240 ||
            !Number.isFinite(currentWindow.sillHeightCm) || currentWindow.sillHeightCm < 0 ||
            !Number.isFinite(currentWindow.heightCm) || currentWindow.heightCm < 40 ||
            currentWindow.sillHeightCm + currentWindow.heightCm > roomHeight()) {
            return 'A window no longer fits on its wall or below the ceiling. Move or remove it, or reshape the room.';
        }
        for (var otherWindow = windowIndex + 1; otherWindow < windows.length; otherWindow++) {
            if (currentWindow.edgeIndex === windows[otherWindow].edgeIndex &&
                currentWindow.t0 < windows[otherWindow].t1 && windows[otherWindow].t0 < currentWindow.t1) {
                return 'Window openings on the same wall cannot overlap.';
            }
        }
    }
    return '';
}

function storedOpeningWidth(opening, points, width, length) {
    var a = points[opening.edgeIndex], b = points[(opening.edgeIndex + 1) % points.length];
    return Math.round(Math.hypot((b[0] - a[0]) * width, (b[1] - a[1]) * length) *
        (opening.t1 - opening.t0) * 1000) / 1000;
}

function restoreRoomConfig() {
    var config = window.RoomfitRoomStorage.read();
    if (!config) return '';
    if (!config || config.version !== 1 ||
        ['rect', 'L', 'bay', 'custom'].indexOf(config.shape) < 0 ||
        !Number.isFinite(config.widthCm) || config.widthCm < 200 || config.widthCm > 1200 ||
        !Number.isFinite(config.lengthCm) || config.lengthCm < 200 || config.lengthCm > 1200 ||
        !Number.isFinite(config.heightCm) || config.heightCm < 200 || config.heightCm > 400 ||
        !Array.isArray(config.polygon) || !validPolygon(config.polygon) ||
        !Array.isArray(config.doors) || config.doors.length > MAX_DOORS ||
        !Array.isArray(config.windows) || config.windows.length > MAX_WINDOWS) {
        return 'Saved room settings are invalid and were not loaded.';
    }

    var savedDoors = config.doors.map(function (door) {
        if (!door || !Number.isInteger(door.edgeIndex) || door.edgeIndex < 0 || door.edgeIndex >= config.polygon.length ||
            !Number.isFinite(door.t0) || !Number.isFinite(door.t1) || door.t0 < 0 || door.t1 > 1 ||
            door.t1 - door.t0 < 0.02 || typeof door.hingeAtStart !== 'boolean' ||
            typeof door.swingInward !== 'boolean' || !Number.isFinite(door.confidence) ||
            door.confidence < 0 || door.confidence > 1) return null;
        var copy = Object.assign({}, door);
        copy.widthCm = storedOpeningWidth(copy, config.polygon, config.widthCm, config.lengthCm);
        copy.tooWide = copy.widthCm < 60 || copy.widthCm > 140;
        return copy;
    });
    var savedWindows = config.windows.map(function (windowItem) {
        if (!windowItem || !Number.isInteger(windowItem.edgeIndex) ||
            windowItem.edgeIndex < 0 || windowItem.edgeIndex >= config.polygon.length ||
            !Number.isFinite(windowItem.t0) || !Number.isFinite(windowItem.t1) ||
            windowItem.t0 < 0 || windowItem.t1 > 1 || windowItem.t1 - windowItem.t0 < 0.02 ||
            !Number.isFinite(windowItem.sillHeightCm) || windowItem.sillHeightCm < 0 ||
            !Number.isFinite(windowItem.heightCm) || windowItem.heightCm < 40 ||
            windowItem.sillHeightCm + windowItem.heightCm > config.heightCm ||
            !Number.isFinite(windowItem.confidence) || windowItem.confidence < 0 || windowItem.confidence > 1) return null;
        var copy = Object.assign({}, windowItem);
        copy.widthCm = storedOpeningWidth(copy, config.polygon, config.widthCm, config.lengthCm);
        copy.invalid = copy.widthCm < 60 || copy.widthCm > 240;
        return copy;
    });
    if (savedDoors.some(function (door) { return !door || door.tooWide; }) ||
        savedWindows.some(function (windowItem) { return !windowItem || windowItem.invalid; })) {
        return 'Saved door or window dimensions are invalid and were not loaded.';
    }
    for (var i = 0; i < savedDoors.length; i++) {
        for (var j = i + 1; j < savedDoors.length; j++) {
            if (savedDoors[i].edgeIndex === savedDoors[j].edgeIndex &&
                savedDoors[i].t0 < savedDoors[j].t1 && savedDoors[j].t0 < savedDoors[i].t1) {
                return 'Saved doors overlap and were not loaded.';
            }
        }
        if (savedWindows.some(function (windowItem) {
            return savedDoors[i].edgeIndex === windowItem.edgeIndex &&
                savedDoors[i].t0 < windowItem.t1 && windowItem.t0 < savedDoors[i].t1;
        })) return 'A saved door overlaps a window; room settings were not loaded.';
    }
    for (var windowIndex = 0; windowIndex < savedWindows.length; windowIndex++) {
        for (var otherWindow = windowIndex + 1; otherWindow < savedWindows.length; otherWindow++) {
            if (savedWindows[windowIndex].edgeIndex === savedWindows[otherWindow].edgeIndex &&
                savedWindows[windowIndex].t0 < savedWindows[otherWindow].t1 &&
                savedWindows[otherWindow].t0 < savedWindows[windowIndex].t1) {
                return 'Saved windows overlap and were not loaded.';
            }
        }
    }
    if (!/^#[0-9a-f]{6}$/i.test(config.wallColor) ||
        typeof config.transparentWalls !== 'boolean' ||
        ['wood', 'carpet', 'marble'].indexOf(config.floorTexture) < 0) {
        return 'Saved wall or floor settings are invalid and were not loaded.';
    }

    poly = config.polygon.map(function (point) { return point.slice(); });
    doors = savedDoors;
    windows = savedWindows;
    roomShape = config.shape;
    $('#roomWidth').value = config.widthCm;
    $('#roomLength').value = config.lengthCm;
    $('#roomHeight').value = config.heightCm;
    roomAppearance = {
        wallColor: config.wallColor.toUpperCase(),
        transparentWalls: config.transparentWalls,
        floorTexture: config.floorTexture
    };
    return '';
}

function saveRoomConfig() {
    if (!roomStorageReady || validationError()) return;
    if (roomStorageTimer) window.clearTimeout(roomStorageTimer);
    roomStorageTimer = null;
    try {
        window.RoomfitRoomStorage.write({
            version: 1,
            shape: roomShape,
            widthCm: roomWidth(),
            lengthCm: roomLength(),
            heightCm: roomHeight(),
            polygon: poly.map(function (point) { return point.slice(); }),
            doors: doors.map(function (door) {
                return {
                    edgeIndex: door.edgeIndex, t0: door.t0, t1: door.t1,
                    hingeAtStart: door.hingeAtStart, swingInward: door.swingInward, confidence: door.confidence
                };
            }),
            windows: windows.map(function (windowItem) {
                return {
                    edgeIndex: windowItem.edgeIndex, t0: windowItem.t0, t1: windowItem.t1,
                    sillHeightCm: windowItem.sillHeightCm, heightCm: windowItem.heightCm,
                    confidence: windowItem.confidence
                };
            }),
            wallColor: roomAppearance.wallColor,
            transparentWalls: roomAppearance.transparentWalls,
            floorTexture: roomAppearance.floorTexture
        });
    } catch (error) {
        console.error('Could not save room settings.', error);
        setStatus('Room settings could not be saved in this browser: ' + error.message, true);
    }
}

function scheduleRoomConfigSave() {
    if (!roomStorageReady || validationError()) return;
    if (roomStorageTimer) window.clearTimeout(roomStorageTimer);
    roomStorageTimer = window.setTimeout(saveRoomConfig, 150);
}

function updateApplyButton() {
    $('#applyRoom').disabled = Boolean(validationError());
}

function setStatus(message, isError) {
    var status = $('#editorStatus');
    status.textContent = message;
    status.classList.toggle('error-text', Boolean(isError));
}

function line(parent, a, b, className, attributes) {
    var element = document.createElementNS(SVG_NS, 'line');
    element.setAttribute('x1', a[0]);
    element.setAttribute('y1', a[1]);
    element.setAttribute('x2', b[0]);
    element.setAttribute('y2', b[1]);
    element.setAttribute('class', className);
    Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, attributes[key]); });
    parent.appendChild(element);
    return element;
}

function drawDoor(door, index, screenPoly, roomArea) {
    var a = screenPoly[door.edgeIndex], b = screenPoly[(door.edgeIndex + 1) % screenPoly.length];
    var p0 = [a[0] + (b[0] - a[0]) * door.t0, a[1] + (b[1] - a[1]) * door.t0];
    var p1 = [a[0] + (b[0] - a[0]) * door.t1, a[1] + (b[1] - a[1]) * door.t1];
    var hinge = door.hingeAtStart ? p0 : p1;
    var other = door.hingeAtStart ? p1 : p0;
    var dx = b[0] - a[0], dy = b[1] - a[1], edgeLength = Math.hypot(dx, dy) || 1;
    var gapLength = Math.hypot(other[0] - hinge[0], other[1] - hinge[1]);
    if (!gapLength) return;
    var along = [(other[0] - hinge[0]) / gapLength, (other[1] - hinge[1]) / gapLength];
    var inward = roomArea >= 0 ? [-dy / edgeLength, dx / edgeLength] : [dy / edgeLength, -dx / edgeLength];
    var normal = door.swingInward ? inward : [-inward[0], -inward[1]];
    var swingEnd = [hinge[0] + normal[0] * gapLength, hinge[1] + normal[1] * gapLength];
    var group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'door-symbol' + (selectedDoor === index ? ' selected' : ''));
    group.setAttribute('data-door-index', index);
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', 'Door ' + (index + 1) + ', ' + Math.round(door.widthCm) + ' centimetres wide');
    drawing.appendChild(group);

    line(group, p0, p1, 'door-hit');
    line(group, hinge, swingEnd, 'door-leaf');
    var arcPath = document.createElementNS(SVG_NS, 'path');
    var arc = [];
    for (var step = 0; step <= 8; step++) {
        var angle = Math.PI * 0.5 * step / 8;
        arc.push([
            hinge[0] + gapLength * (along[0] * Math.cos(angle) + normal[0] * Math.sin(angle)),
            hinge[1] + gapLength * (along[1] * Math.cos(angle) + normal[1] * Math.sin(angle))
        ]);
    }
    arcPath.setAttribute('d', arc.map(function (point, arcIndex) {
        return (arcIndex ? 'L ' : 'M ') + point[0] + ' ' + point[1];
    }).join(' '));
    arcPath.setAttribute('class', 'door-arc');
    group.appendChild(arcPath);
}

function drawWindow(windowItem, index, screenPoly, roomArea) {
    var a = screenPoly[windowItem.edgeIndex], b = screenPoly[(windowItem.edgeIndex + 1) % screenPoly.length];
    var p0 = [a[0] + (b[0] - a[0]) * windowItem.t0, a[1] + (b[1] - a[1]) * windowItem.t0];
    var p1 = [a[0] + (b[0] - a[0]) * windowItem.t1, a[1] + (b[1] - a[1]) * windowItem.t1];
    var dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
    var inward = roomArea >= 0 ? [-dy / length, dx / length] : [dy / length, -dx / length];
    var offset = [inward[0] * 4, inward[1] * 4];
    var group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'window-symbol' + (selectedWindow === index ? ' selected' : ''));
    group.setAttribute('data-window-index', index);
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', 'Window ' + (index + 1) + ', ' + Math.round(windowItem.widthCm) + ' centimetres wide');
    drawing.appendChild(group);
    line(group, p0, p1, 'window-hit');
    line(group, p0, p1, 'window-pane');
    line(group, [p0[0] + offset[0], p0[1] + offset[1]],
        [p1[0] + offset[0], p1[1] + offset[1]], 'window-frame');
}

function renderDrawing() {
    var bounds = drawingBounds();
    var screenPoly = poly.map(function (point) { return toScreen(point, bounds); });
    drawing.innerHTML = '';

    var roomPath = document.createElementNS(SVG_NS, 'path');
    roomPath.setAttribute('d', screenPoly.map(function (point, index) {
        return (index ? 'L ' : 'M ') + point[0] + ' ' + point[1];
    }).join(' ') + ' Z');
    roomPath.setAttribute('class', 'room-fill');
    drawing.appendChild(roomPath);

    var roomArea = signedArea(screenPoly);
    for (var edgeIndex = 0; edgeIndex < screenPoly.length; edgeIndex++) {
        var a = screenPoly[edgeIndex], b = screenPoly[(edgeIndex + 1) % screenPoly.length];
        var edgeOpenings = [];
        doors.forEach(function (door) {
            if (door.edgeIndex === edgeIndex) edgeOpenings.push({ type: 'door', opening: door });
        });
        windows.forEach(function (windowItem) {
            if (windowItem.edgeIndex === edgeIndex) edgeOpenings.push({ type: 'window', opening: windowItem });
        });
        edgeOpenings.sort(function (first, second) { return first.opening.t0 - second.opening.t0; });
        var cursor = 0;
        edgeOpenings.forEach(function (entry) {
            var opening = entry.opening;
            var gapStart = [a[0] + (b[0] - a[0]) * opening.t0, a[1] + (b[1] - a[1]) * opening.t0];
            var gapEnd = [a[0] + (b[0] - a[0]) * opening.t1, a[1] + (b[1] - a[1]) * opening.t1];
            if (opening.t0 > cursor) {
                line(drawing,
                    [a[0] + (b[0] - a[0]) * cursor, a[1] + (b[1] - a[1]) * cursor],
                    gapStart, 'room-wall');
            }
            cursor = Math.max(cursor, opening.t1);
            line(drawing, gapStart, gapEnd, entry.type === 'door' ? 'door-threshold' : 'window-gap');
        });
        if (cursor < 1) {
            line(drawing,
                [a[0] + (b[0] - a[0]) * cursor, a[1] + (b[1] - a[1]) * cursor],
                b, 'room-wall');
        }
    }

    doors.forEach(function (door, index) { drawDoor(door, index, screenPoly, roomArea); });
    windows.forEach(function (windowItem, index) { drawWindow(windowItem, index, screenPoly, roomArea); });
    screenPoly.forEach(function (point, index) {
        var group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'room-vertex' + (selectedVertex === index ? ' selected' : ''));
        group.setAttribute('data-vertex-index', index);
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', 'Corner ' + (index + 1) + ', drag to move');
        var hit = document.createElementNS(SVG_NS, 'circle');
        hit.setAttribute('cx', point[0]);
        hit.setAttribute('cy', point[1]);
        hit.setAttribute('r', 18);
        hit.setAttribute('class', 'vertex-hit');
        group.appendChild(hit);
        var handle = document.createElementNS(SVG_NS, 'circle');
        handle.setAttribute('cx', point[0]);
        handle.setAttribute('cy', point[1]);
        handle.setAttribute('r', selectedVertex === index ? 8 : 6);
        handle.setAttribute('class', 'vertex-handle');
        group.appendChild(handle);
        drawing.appendChild(group);
    });
}

function renderCornerList() {
    var container = $('#cornerList');
    container.innerHTML = '';
    poly.forEach(function (point, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-item' + (selectedVertex === index ? ' selected' : '');
        button.textContent = 'Corner ' + (index + 1) + ' · ' +
            Math.round(point[0] * 100) + '%, ' + Math.round(point[1] * 100) + '%';
        button.setAttribute('aria-pressed', String(selectedVertex === index));
        button.addEventListener('click', function () {
            selectedVertex = index;
            render();
        });
        container.appendChild(button);
    });
}

function renderDoorList() {
    var container = $('#doorList');
    container.innerHTML = '';
    doors.forEach(function (door, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-item' + (selectedDoor === index ? ' selected' : '');
        button.textContent = 'Door ' + (index + 1) + ' · wall ' + (door.edgeIndex + 1) +
            ' · ' + Math.round(door.widthCm) + ' cm';
        button.setAttribute('aria-pressed', String(selectedDoor === index));
        button.addEventListener('click', function () {
            selectedDoor = index;
            $('#doorWidth').value = Math.round(door.widthCm);
            render();
        });
        container.appendChild(button);
    });
    $('#removeDoor').disabled = selectedDoor < 0 || selectedDoor >= doors.length;
    $('#flipHinge').disabled = selectedDoor < 0 || selectedDoor >= doors.length;
    $('#flipSwing').disabled = selectedDoor < 0 || selectedDoor >= doors.length;
    if (selectedDoor < 0 || selectedDoor >= doors.length) selectedDoor = -1;
}

function renderWindowList() {
    var container = $('#windowList');
    container.innerHTML = '';
    windows.forEach(function (windowItem, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'editor-item' + (selectedWindow === index ? ' selected' : '');
        button.textContent = 'Window ' + (index + 1) + ' · wall ' + (windowItem.edgeIndex + 1) +
            ' · ' + Math.round(windowItem.widthCm) + ' × ' + Math.round(windowItem.heightCm) + ' cm';
        button.setAttribute('aria-pressed', String(selectedWindow === index));
        button.addEventListener('click', function () {
            selectedWindow = index;
            $('#windowWidth').value = Math.round(windowItem.widthCm);
            $('#windowSill').value = Math.round(windowItem.sillHeightCm);
            $('#windowHeight').value = Math.round(windowItem.heightCm);
            render();
        });
        container.appendChild(button);
    });
    $('#removeWindow').disabled = selectedWindow < 0 || selectedWindow >= windows.length;
    if (selectedWindow < 0 || selectedWindow >= windows.length) selectedWindow = -1;
}

function render() {
    refreshDoorGeometry();
    refreshWindowGeometry();
    document.querySelectorAll('input[name=roomShape]').forEach(function (input) {
        input.checked = input.value === roomShape;
    });
    renderDrawing();
    renderCornerList();
    renderDoorList();
    renderWindowList();
    $('#removeCorner').disabled = poly.length <= 3;
    $('#addCorner').disabled = poly.length >= MAX_CORNERS;
    $('#addCorner').textContent = mode === 'add-corner' ? 'Cancel corner placement' : 'Add corner';
    $('#addDoor').textContent = mode === 'add-door' ? 'Cancel door placement' : 'Add door';
    $('#addWindow').textContent = mode === 'add-window' ? 'Cancel window placement' : 'Add window';
    $('.floorplan-editor').classList.toggle('is-placement', mode !== 'idle');
    updateApplyButton();

    var error = validationError();
    if (error) setStatus(error, true);
    else if (mode === 'add-corner') setStatus('Click a wall near where you want the new corner.', false);
    else if (mode === 'add-door') setStatus('Click the wall where the centre of the door should go.', false);
    else if (mode === 'add-window') setStatus('Click the wall where the centre of the window should go.', false);
    else if (roomShape !== 'custom') setStatus('Preset selected. Drag a corner or adjust an opening to customize it.', false);
    else setStatus('Drag a corner, add a corner, or add a door or window to shape the room.', false);
    scheduleRoomConfigSave();
}

function distanceToSegment(point, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var lengthSquared = dx * dx + dy * dy;
    var t = lengthSquared ? clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0, 1) : 0;
    var nearest = [a[0] + dx * t, a[1] + dy * t];
    return { distance: Math.hypot(point[0] - nearest[0], point[1] - nearest[1]), t: t };
}

function closestWall(point) {
    var bounds = drawingBounds(), screenPoly = poly.map(function (candidate) { return toScreen(candidate, bounds); });
    var best = null;
    for (var i = 0; i < screenPoly.length; i++) {
        var result = distanceToSegment(point, screenPoly[i], screenPoly[(i + 1) % screenPoly.length]);
        if (!best || result.distance < best.distance) {
            best = { edgeIndex: i, distance: result.distance, t: result.t };
        }
    }
    return best;
}

function addCorner(point) {
    if (poly.length >= MAX_CORNERS) {
        setStatus('The outline already has the maximum of ' + MAX_CORNERS + ' corners.', true);
        return;
    }
    var wall = closestWall(point);
    if (!wall || wall.distance > 28 || wall.t < 0.02 || wall.t > 0.98) {
        setStatus('Click closer to the middle of a wall to add a corner.', true);
        return;
    }
    var split = wall.t, edgeIndex = wall.edgeIndex;
    if (doors.some(function (door) {
        return door.edgeIndex === edgeIndex && split > door.t0 && split < door.t1;
    }) || windows.some(function (windowItem) {
        return windowItem.edgeIndex === edgeIndex && split > windowItem.t0 && split < windowItem.t1;
    })) {
        setStatus('Remove or move the opening before adding a corner through it.', true);
        return;
    }

    function remapOpenings(openings) {
        return openings.map(function (opening) {
            var copy = Object.assign({}, opening);
            if (copy.edgeIndex > edgeIndex) copy.edgeIndex++;
            else if (copy.edgeIndex === edgeIndex) {
                if (copy.t1 <= split) {
                    copy.t0 /= split;
                    copy.t1 /= split;
                } else if (copy.t0 >= split) {
                    copy.edgeIndex++;
                    copy.t0 = (copy.t0 - split) / (1 - split);
                    copy.t1 = (copy.t1 - split) / (1 - split);
                }
            }
            return copy;
        });
    }
    var oldDoors = remapOpenings(doors);
    var oldWindows = remapOpenings(windows);
    var a = poly[edgeIndex], b = poly[(edgeIndex + 1) % poly.length];
    poly.splice(edgeIndex + 1, 0, [
        a[0] + (b[0] - a[0]) * split,
        a[1] + (b[1] - a[1]) * split
    ]);
    roomShape = 'custom';
    doors = oldDoors;
    windows = oldWindows;
    selectedVertex = edgeIndex + 1;
    mode = 'idle';
    render();
}

function addDoor(point) {
    if (doors.length >= MAX_DOORS) {
        setStatus('A room can have at most ' + MAX_DOORS + ' doors.', true);
        return;
    }
    var width = Number($('#doorWidth').value);
    if (!Number.isFinite(width) || width < 60 || width > 140) {
        setStatus('Set the door width between 60 and 140 cm.', true);
        return;
    }
    var wall = closestWall(point);
    if (!wall || wall.distance > 28) {
        setStatus('Click closer to a wall to place the door.', true);
        return;
    }
    var edgeLength = edgeLengthCm(wall.edgeIndex);
    var fraction = width / edgeLength;
    if (fraction > 0.9) {
        setStatus('This wall is too short for a ' + width + ' cm door. Use a smaller width or a longer wall.', true);
        return;
    }
    var center = clamp(wall.t, fraction / 2, 1 - fraction / 2);
    var door = {
        edgeIndex: wall.edgeIndex,
        t0: center - fraction / 2,
        t1: center + fraction / 2,
        hingeAtStart: true,
        swingInward: true,
        confidence: 1,
        widthCm: width,
        tooWide: false
    };
    if (doors.some(function (other) {
        return other.edgeIndex === door.edgeIndex && door.t0 < other.t1 && other.t0 < door.t1;
    }) || windows.some(function (windowItem) {
        return windowItem.edgeIndex === door.edgeIndex && door.t0 < windowItem.t1 && windowItem.t0 < door.t1;
    })) {
        setStatus('That door overlaps another opening on this wall.', true);
        return;
    }
    doors.push(door);
    roomShape = 'custom';
    selectedDoor = doors.length - 1;
    mode = 'idle';
    render();
}

function addWindow(point) {
    if (windows.length >= MAX_WINDOWS) {
        setStatus('A room can have at most ' + MAX_WINDOWS + ' windows.', true);
        return;
    }
    var width = Number($('#windowWidth').value);
    var sill = Number($('#windowSill').value);
    var height = Number($('#windowHeight').value);
    if (!Number.isFinite(width) || width < 60 || width > 240 ||
        !Number.isFinite(sill) || sill < 0 ||
        !Number.isFinite(height) || height < 40 || sill + height > roomHeight()) {
        setStatus('Set a window width from 60–240 cm and a sill and height that fit below the ceiling.', true);
        return;
    }
    var wall = closestWall(point);
    if (!wall || wall.distance > 28) {
        setStatus('Click closer to a wall to place the window.', true);
        return;
    }
    var edgeLength = edgeLengthCm(wall.edgeIndex);
    var fraction = width / edgeLength;
    if (fraction > 0.9) {
        setStatus('This wall is too short for a ' + width + ' cm window. Use a smaller width or a longer wall.', true);
        return;
    }
    var center = clamp(wall.t, fraction / 2, 1 - fraction / 2);
    var windowItem = {
        edgeIndex: wall.edgeIndex,
        t0: center - fraction / 2,
        t1: center + fraction / 2,
        widthCm: width,
        sillHeightCm: sill,
        heightCm: height,
        confidence: 1,
        invalid: false
    };
    if (doors.some(function (door) {
        return door.edgeIndex === windowItem.edgeIndex && windowItem.t0 < door.t1 && door.t0 < windowItem.t1;
    }) || windows.some(function (other) {
        return other.edgeIndex === windowItem.edgeIndex && windowItem.t0 < other.t1 && other.t0 < windowItem.t1;
    })) {
        setStatus('That window overlaps another opening on this wall.', true);
        return;
    }
    windows.push(windowItem);
    roomShape = 'custom';
    selectedWindow = windows.length - 1;
    mode = 'idle';
    render();
}

$('#addCorner').addEventListener('click', function () {
    mode = mode === 'add-corner' ? 'idle' : 'add-corner';
    render();
});

document.querySelectorAll('input[name=roomShape]').forEach(function (input) {
    input.addEventListener('change', function () {
        if (this.value === 'custom') {
            roomShape = 'custom';
            render();
            return;
        }
        if (!applyPresetShape(this.value)) {
            render();
            setStatus('Enter valid room dimensions before choosing a preset.', true);
            return;
        }
        selectedVertex = 0;
        selectedDoor = -1;
        selectedWindow = -1;
        mode = 'idle';
        render();
    });
});

$('#removeWindow').addEventListener('click', function () {
    if (selectedWindow < 0 || selectedWindow >= windows.length) return;
    windows.splice(selectedWindow, 1);
    roomShape = 'custom';
    selectedWindow = -1;
    render();
});

$('#addDoor').addEventListener('click', function () {
    mode = mode === 'add-door' ? 'idle' : 'add-door';
    render();
});

$('#addWindow').addEventListener('click', function () {
    mode = mode === 'add-window' ? 'idle' : 'add-window';
    render();
});

$('#removeCorner').addEventListener('click', function () {
    if (poly.length <= 3 || selectedVertex < 0) return;
    var previousEdge = (selectedVertex - 1 + poly.length) % poly.length;
    var selectedEdge = selectedVertex;
    if (doors.some(function (door) { return door.edgeIndex === previousEdge || door.edgeIndex === selectedEdge; }) ||
        windows.some(function (windowItem) { return windowItem.edgeIndex === previousEdge || windowItem.edgeIndex === selectedEdge; })) {
        setStatus('Remove the door or window on this corner’s wall before removing the corner.', true);
        return;
    }
    poly.splice(selectedVertex, 1);
    roomShape = 'custom';
    doors = doors.map(function (door) {
        if (door.edgeIndex > selectedVertex) door.edgeIndex--;
        return door;
    });
    windows = windows.map(function (windowItem) {
        if (windowItem.edgeIndex > selectedVertex) windowItem.edgeIndex--;
        return windowItem;
    });
    selectedVertex = Math.min(selectedVertex, poly.length - 1);
    render();
});

$('#resetShape').addEventListener('click', function () {
    poly = [[0, 0], [1, 0], [1, 1], [0, 1]];
    doors = [];
    windows = [];
    selectedVertex = 0;
    selectedDoor = -1;
    selectedWindow = -1;
    mode = 'idle';
    $('#roomWidth').value = 420;
    $('#roomLength').value = 360;
    $('#roomHeight').value = 250;
    $('#doorWidth').value = 90;
    $('#windowWidth').value = 120;
    $('#windowSill').value = 90;
    $('#windowHeight').value = 110;
    roomShape = 'custom';
    render();
    saveRoomConfig();
});

$('#removeDoor').addEventListener('click', function () {
    if (selectedDoor < 0 || selectedDoor >= doors.length) return;
    doors.splice(selectedDoor, 1);
    roomShape = 'custom';
    selectedDoor = -1;
    render();
});

$('#flipHinge').addEventListener('click', function () {
    if (selectedDoor < 0 || selectedDoor >= doors.length) return;
    doors[selectedDoor].hingeAtStart = !doors[selectedDoor].hingeAtStart;
    roomShape = 'custom';
    render();
});

$('#flipSwing').addEventListener('click', function () {
    if (selectedDoor < 0 || selectedDoor >= doors.length) return;
    doors[selectedDoor].swingInward = !doors[selectedDoor].swingInward;
    roomShape = 'custom';
    render();
});

$('#doorWidth').addEventListener('input', function () {
    var width = Number(this.value);
    if (selectedDoor >= 0 && selectedDoor < doors.length && Number.isFinite(width)) {
        doors[selectedDoor].widthCm = width;
        roomShape = 'custom';
        refreshDoorGeometry();
    }
    updateApplyButton();
    render();
});

['#windowWidth', '#windowSill', '#windowHeight'].forEach(function (selector) {
    $(selector).addEventListener('input', function () {
        if (selectedWindow >= 0 && selectedWindow < windows.length) {
            var windowItem = windows[selectedWindow];
            windowItem.widthCm = Number($('#windowWidth').value);
            windowItem.sillHeightCm = Number($('#windowSill').value);
            windowItem.heightCm = Number($('#windowHeight').value);
            roomShape = 'custom';
            refreshWindowGeometry();
        }
        render();
    });
});

['#roomWidth', '#roomLength', '#roomHeight'].forEach(function (selector) {
    $(selector).addEventListener('input', function () {
        if (roomShape !== 'custom' && applyPresetShape(roomShape)) {
            selectedDoor = -1;
            selectedWindow = -1;
        } else {
            refreshDoorGeometry();
            refreshWindowGeometry();
        }
        render();
    });
});

svg.addEventListener('pointerdown', function (event) {
    var vertex = event.target.closest('[data-vertex-index]');
    if (!vertex) return;
    dragVertex = Number(vertex.getAttribute('data-vertex-index'));
    selectedVertex = dragVertex;
    svg.setPointerCapture(event.pointerId);
    event.preventDefault();
    render();
});

svg.addEventListener('pointermove', function (event) {
    if (dragVertex < 0) return;
    var point = svgEventPoint(event);
    if (!point) return;
    poly[dragVertex] = toNormalized(point);
    roomShape = 'custom';
    refreshDoorGeometry();
    refreshWindowGeometry();
    render();
});

svg.addEventListener('pointerup', function (event) {
    if (dragVertex < 0) return;
    dragVertex = -1;
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    render();
});

svg.addEventListener('pointercancel', function () {
    dragVertex = -1;
    render();
});

svg.addEventListener('click', function (event) {
    var doorElement = event.target.closest('[data-door-index]');
    if (doorElement) {
        selectedDoor = Number(doorElement.getAttribute('data-door-index'));
        $('#doorWidth').value = Math.round(doors[selectedDoor].widthCm);
        render();
        return;
    }
    var windowElement = event.target.closest('[data-window-index]');
    if (windowElement) {
        selectedWindow = Number(windowElement.getAttribute('data-window-index'));
        var selected = windows[selectedWindow];
        $('#windowWidth').value = Math.round(selected.widthCm);
        $('#windowSill').value = Math.round(selected.sillHeightCm);
        $('#windowHeight').value = Math.round(selected.heightCm);
        render();
        return;
    }
    var vertexElement = event.target.closest('[data-vertex-index]');
    if (vertexElement) {
        selectedVertex = Number(vertexElement.getAttribute('data-vertex-index'));
        render();
        return;
    }
    if (mode === 'idle') return;
    var point = svgEventPoint(event);
    if (!point) return;
    if (mode === 'add-corner') addCorner(point);
    else if (mode === 'add-door') addDoor(point);
    else addWindow(point);
});

svg.addEventListener('keydown', function (event) {
    var vertex = event.target.closest('[data-vertex-index]');
    if (!vertex) return;
    var index = Number(vertex.getAttribute('data-vertex-index'));
    var step = event.shiftKey ? 0.05 : 0.01;
    var dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    var dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    selectedVertex = index;
    poly[index] = [clamp(poly[index][0] + dx, 0, 1), clamp(poly[index][1] + dy, 0, 1)];
    roomShape = 'custom';
    refreshDoorGeometry();
    refreshWindowGeometry();
    render();
    var focusedVertex = svg.querySelector('[data-vertex-index="' + index + '"]');
    if (focusedVertex) focusedVertex.focus();
});

$('#applyRoom').addEventListener('click', function () {
    var error = validationError();
    if (error) {
        setStatus(error, true);
        updateApplyButton();
        return;
    }
    var target = new URL('Roomfit.html', window.location.href);
    target.search = new URLSearchParams({
        roomWidth: String(roomWidth()),
        roomLength: String(roomLength()),
        roomHeight: String(roomHeight()),
        roomShape: roomShape,
        roomPoly: JSON.stringify(poly),
        roomWindows: JSON.stringify(windows.map(function (windowItem) {
            return {
                edgeIndex: windowItem.edgeIndex,
                t0: windowItem.t0,
                t1: windowItem.t1,
                sillHeightCm: windowItem.sillHeightCm,
                heightCm: windowItem.heightCm,
                confidence: 1
            };
        })),
        roomDoors: JSON.stringify(doors.map(function (door) {
            return {
                edgeIndex: door.edgeIndex,
                t0: door.t0,
                t1: door.t1,
                hingeAtStart: door.hingeAtStart,
                swingInward: door.swingInward,
                confidence: 1
            };
        }))
    }).toString();
    saveRoomConfig();
    window.location.href = target.href;
});

$('#backToRoom').addEventListener('click', saveRoomConfig);
window.addEventListener('pagehide', saveRoomConfig);
var roomStorageMessage = '';
try {
    roomStorageMessage = restoreRoomConfig();
} catch (error) {
    console.error('Could not read saved room settings.', error);
    roomStorageMessage = 'Saved room settings could not be read: ' + error.message;
}
render();
roomStorageReady = true;
if (roomStorageMessage) setStatus(roomStorageMessage, true);
}());
