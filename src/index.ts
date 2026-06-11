import { handleRequest, type Env } from "./mcp";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
} satisfies ExportedHandler<Env>;

export { handleRequest };

