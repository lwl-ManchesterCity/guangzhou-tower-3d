const paths = {
  park: '<path d="m12 2 6 8h-3l5 7H4l5-7H6l6-8ZM12 17v5M8 22h8"/>',
  food: '<path d="M5 3v7m3-7v7M3 3v4a3 3 0 0 0 6 0V3M6 10v11M16 3c-3 2-3 8 0 9h2M18 3v18"/>',
  visit: '<path d="m3 9 9-6 9 6H3Zm2 3v6m5-6v6m4-6v6m5-6v6M3 21h18"/>',
  transit: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 11h14M8 18l-2 3m10-3 2 3M9 7h6"/><circle cx="9" cy="14" r=".8"/><circle cx="15" cy="14" r=".8"/>',
  shop: '<path d="M5 8h14l2 13H3L5 8Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>',
};

export function iconSvg(type, color = 'currentColor') {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[type]}</svg>`;
}

export async function mapIcon(category) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="${category.color}" stroke="#fff" stroke-width="3"/><g transform="translate(16 16) scale(1.333)" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[category.icon]}</g></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, 64, 64);
}
