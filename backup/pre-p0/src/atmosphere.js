import { BUILDING_COLORS, RADIUS_METERS } from './config.js';

export const ATMOSPHERES = {
  day: {
    label: '白昼', background: '#e9eeeb', water: '#94c1c6', park: '#b1c9af', grass: '#b5cdb4', land: '#e4eae3', footprint: '#d5d8d0',
    road: '#f6f7f2', casing: '#c9d1c9', roadGap: '#c5ceca', text: '#6f807d', waterText: '#537f8c', halo: '#eef3ef',
    buildings: BUILDING_COLORS, distant: '#d9ded8', context: '#ccd3ce', selection: '#1f4e5f', radius: '#52838a',
    towerText: '#365f66', towerHalo: '#f5f8f2', poiText: '#304c50', poiHalo: '#fbfcf8',
    sky: { 'sky-color': '#e8f0f0', 'horizon-color': '#e8f0f0', 'fog-color': '#e8f0f0' },
    light: { anchor: 'map', color: '#fff5e5', intensity: 0.45, position: [1.5, 210, 38] },
    tower: {
      colors: { silver: '#d4dfe0', pale: '#e7ece9', diagonal: '#8da5ad', glass: '#72949c', warm: '#d9a669' },
      emission: { silver: ['#000000', 0], pale: ['#000000', 0], diagonal: ['#000000', 0], glass: ['#000000', 0], warm: ['#000000', 0] },
      hemisphere: ['#f5fbff', '#84918c', 2.4], directional: ['#fff4df', 2.7], position: [-300, 600, 400],
    },
  },
  sunset: {
    label: '日落', background: '#d9b6a0', water: '#a98c9c', park: '#9a9e80', grass: '#a8a389', land: '#d2b19a', footprint: '#baa092',
    road: '#efd0ac', casing: '#b29487', roadGap: '#aa8d82', text: '#765966', waterText: '#674c65', halo: '#e9c4a8',
    otherFill: '#d2b19a', otherLine: '#b59591',
    buildings: { commercial: '#ce987e', residential: '#dfc39d', public: '#a59ab4', unknown: '#b9a5a1' },
    distant: '#c3a0a0', context: '#b89b98', selection: '#864b66', radius: '#896078',
    towerText: '#724452', towerHalo: '#f6d2af', poiText: '#664452', poiHalo: '#f3d2b7',
    sky: { 'sky-color': '#a099b6', 'horizon-color': '#f6bc90', 'fog-color': '#d7aca8' },
    light: { anchor: 'map', color: '#ffd2a2', intensity: 0.6, position: [1.5, 255, 72] },
    tower: {
      colors: { silver: '#ecd0aa', pale: '#ffe2b5', diagonal: '#b58e96', glass: '#877a96', warm: '#f1b478' },
      emission: { silver: ['#ad6952', 0.05], pale: ['#ffc88c', 0.1], diagonal: ['#000000', 0], glass: ['#725a88', 0.08], warm: ['#ffb46e', 0.18] },
      hemisphere: ['#e4c4d8', '#77657e', 1.7], directional: ['#ffc189', 3.1], position: [-650, 180, 200],
    },
  },
  night: {
    label: '夜景', background: '#182b40', water: '#102d46', park: '#234344', grass: '#294749', land: '#1c3044', footprint: '#263c51',
    road: '#46596c', casing: '#21374c', roadGap: '#2b4058', text: '#a1b5c9', waterText: '#85b6ce', halo: '#172b42',
    otherFill: '#1c3044', otherLine: '#3b5066',
    buildings: { commercial: '#607a97', residential: '#485b73', public: '#638d9d', unknown: '#3b4e64' },
    distant: '#26384c', context: '#2c4056', selection: '#b1dbe1', radius: '#688ca7',
    towerText: '#dcebf4', towerHalo: '#172b42', poiText: '#e0eaf0', poiHalo: '#172b42',
    sky: { 'sky-color': '#0b162c', 'horizon-color': '#304761', 'fog-color': '#1e334d' },
    light: { anchor: 'map', color: '#c3d8fc', intensity: 0.38, position: [1.5, 210, 28] },
    tower: {
      colors: { silver: '#859dc4', pale: '#d7bbec', diagonal: '#566e91', glass: '#273f60', warm: '#edbf82' },
      emission: { silver: ['#75bccc', 0.7], pale: ['#b07be0', 0.95], diagonal: ['#425e8e', 0.3], glass: ['#386396', 0.25], warm: ['#ffc888', 0.9] },
      hemisphere: ['#a2badf', '#283851', 0.85], directional: ['#adcafa', 1.2], position: [-300, 600, 400],
    },
  },
};

export function baseAtmospherePaint(layer, theme) {
  const source = layer['source-layer'];
  const paint = {};
  if (layer.type === 'background') paint['background-color'] = theme.background;
  if (layer.type === 'fill') {
    if (theme.otherFill && layer.paint?.['fill-color']) paint['fill-color'] = theme.otherFill;
    if (layer.paint?.['fill-pattern']) Object.assign(paint, { 'fill-pattern': theme.otherFill ? null : layer.paint['fill-pattern'], 'fill-color': theme.land });
    if (source === 'water') paint['fill-color'] = theme.water;
    if (['park', 'landcover'].includes(source)) paint['fill-color'] = theme.park;
    if (source === 'landuse') paint['fill-color'] = ['match', ['get', 'class'], ['park', 'recreation_ground', 'grass', 'cemetery'], theme.grass, theme.land];
    if (source === 'building') Object.assign(paint, { 'fill-color': theme.footprint, 'fill-opacity': 0.5 });
  }
  if (layer.type === 'line') {
    if (theme.otherLine && layer.paint?.['line-color']) paint['line-color'] = theme.otherLine;
    if (source === 'waterway') paint['line-color'] = theme.water;
    if (source === 'transportation') paint['line-color'] = layer.paint?.['line-gap-width'] ? theme.roadGap : layer.id.includes('casing') ? theme.casing : theme.road;
  }
  if (layer.type === 'symbol' && layer.layout?.['text-field']) Object.assign(paint, {
    'text-color': source === 'water_name' ? theme.waterText : theme.text,
    'text-halo-color': theme.halo, 'text-halo-width': 1.4,
  });
  return paint;
}

export function buildingAtmosphereColor(theme) {
  const color = ['match', ['get', 'category'], ...Object.entries(theme.buildings).filter(([key]) => key !== 'unknown').flat(), theme.buildings.unknown];
  return ['interpolate', ['linear'], ['get', 'distance'], 0, color, 1600, color, RADIUS_METERS, theme.distant];
}
