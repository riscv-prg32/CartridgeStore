const icon = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="118" fill="#7045dc"/>
    <path fill="#fff" d="M173 128h93c53 0 85 29 85 77s-32 77-85 77h-48v102h-45V128Zm45 40v74h45c27 0 43-13 43-37s-16-37-43-37h-45Z"/>
  </svg>
`;

export function GET() {
  return new Response(icon, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
