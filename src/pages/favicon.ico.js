export function GET() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#09111f"/>
    <path d="M14 42h36" stroke="#44d7d0" stroke-width="6" stroke-linecap="round"/>
    <path d="M18 34l10-12 8 9 10-15" fill="none" stroke="#5aa7ff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400"
    }
  });
}
