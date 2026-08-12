/// <reference types="vite/client" />

declare module '*.psdl?raw' {
  const content: string;
  export default content;
}

declare module '*.adoc?adoc-html' {
  const content: string;
  export default content;
}

declare module '*.adoc?adoc' {
  const content: string;
  export default content;
}
