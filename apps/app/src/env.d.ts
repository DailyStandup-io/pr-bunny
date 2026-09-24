declare module "*.sql" {
  const text: string;
  export default text;
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*/Caddyfile" {
  const text: string;
  export default text;
}
