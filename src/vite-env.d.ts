/// <reference types="vite/client" />

declare module "*.svg" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: string;
  export default content;
}

declare module "*.jpg" {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_ELEVENLABS_API_KEY: string
  readonly VITE_ELEVENLABS_VOICE_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
