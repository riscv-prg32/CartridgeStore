const icon = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
    <rect width="192" height="192" rx="44" fill="#7045dc"/>
    <path fill="#fff" d="M65 48h35c20 0 32 11 32 29s-12 29-32 29H82v38H65V48Zm17 15v28h17c10 0 16-5 16-14s-6-14-16-14H82Z"/>
  </svg>
`;

export function GET() {
  return new Response(icon, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
