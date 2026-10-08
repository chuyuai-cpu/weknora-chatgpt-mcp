import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiEnv } from "./knowledge-tools.ts";

// Fail closed: all four runtime requirements must be met before writes register.
// The API key used for read operations is never silently reused for writes.
export const WRITE_SCOPE = "mcp:write";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_LIMIT = 20;
export function permittedWriteKbs(env: ApiEnv): Set<string> {
  const raw = (env.WRITE_ALLOWED_KB_IDS ?? "").split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
  if (raw.length === 0 || raw.length > ALLOWED_LIMIT || raw.some(id=>!UUID.test(id))) return new Set();
  return new Set(raw);
}
export function isWriteReady(env: ApiEnv & { OWNER_AUTH_SECRET?: string }): boolean {
  return env.MCP_WRITE_ENABLED === "true" &&
    typeof env.OWNER_AUTH_SECRET === "string" && env.OWNER_AUTH_SECRET.length >= 20 &&
    typeof env.WEKNORA_WRITE_API_KEY === "string" && env.WEKNORA_WRITE_API_KEY.length > 15 &&
    env.WEKNORA_WRITE_API_KEY !== env.WEKNORA_API_KEY &&
    permittedWriteKbs(env).size > 0;
}
type RequestFn = (env: ApiEnv, method: "GET" | "POST" | "PUT", path: string, body?: unknown)=>Promise<unknown>;
function data(v: unknown): unknown {
  return v && typeof v === "object" && "data" in v ? (v as {data:unknown}).data : v;
}
function result(v:unknown) {
  return {content:[{type:"text" as const,text:JSON.stringify(v)}]};
}

export function registerWriteTools(server:McpServer,env:ApiEnv,request:RequestFn):void {
  const permitted=permittedWriteKbs(env);
  if (permitted.size===0 || !env.WEKNORA_WRITE_API_KEY) return;
  const writeEnv={...env,WEKNORA_API_KEY:env.WEKNORA_WRITE_API_KEY};
  const ensureAllowed=(id:string)=> {
    if(!permitted.has(id.toLowerCase())) throw new Error("Knowledge base not authorized for writes");
  };
  server.tool("create_manual_knowledge",
    "Create draft Markdown knowledge in a specifically authorized knowledge base. Preview by default. Never deletes or publishes automatically.",
    {
      kb_id:z.string().uuid(),
      title:z.string().trim().min(1).max(200),
      content:z.string().min(1).max(120000),
      mode:z.enum(["preview","execute"]).default("preview"),
      confirm:z.boolean().default(false),
    },
    async ({kb_id,title,content,mode,confirm})=>{
      ensureAllowed(kb_id);
      if(mode==="preview") return result({operation:"create",kb_id,title,content_length:content.length,status:"draft",requires_confirmation:true,performed:false});
      if(!confirm) throw new Error("Explicit confirmation required");
      const payload=data(await request(writeEnv,"POST",`knowledge-bases/${encodeURIComponent(kb_id)}/knowledge/manual`,{
        title,content,status:"draft",
      }));
      return result({operation:"create",performed:true,knowledge:payload});
    },
  );
  server.tool("update_manual_knowledge",
    "Update manual Markdown knowledge only, with current timestamp precondition and explicit confirmation. Preview by default.",
    {
      kb_id:z.string().uuid(),
      knowledge_id:z.string().uuid(),
      title:z.string().trim().min(1).max(200),
      content:z.string().min(1).max(120000),
      expected_updated_at:z.string().min(10).max(80),
      mode:z.enum(["preview","execute"]).default("preview"),
      confirm:z.boolean().default(false),
    },
    async ({kb_id,knowledge_id,title,content,expected_updated_at,mode,confirm})=>{
      ensureAllowed(kb_id);
      // Always read the latest record first, including during preview.
      const previous=data(await request(env,"GET",`knowledge/${encodeURIComponent(knowledge_id)}`)) as Record<string,unknown>;
      if(!previous || previous.knowledge_base_id!==kb_id || previous.type!=="manual")
        throw new Error("Knowledge record does not match authorized manual knowledge base");
      if(previous.updated_at !== expected_updated_at)
        throw new Error("Knowledge changed after review; refusing stale update");
      if(mode==="preview")
        return result({operation:"update",knowledge_id,kb_id,title,content_length:content.length,status:"draft",performed:false,expected_updated_at});
      if(!confirm) throw new Error("Explicit confirmation required");
      const payload=data(await request(writeEnv,"PUT",`knowledge/manual/${encodeURIComponent(knowledge_id)}`,{
        title,content,status:"draft",
      }));
      return result({operation:"update",performed:true,knowledge:payload});
    },
  );
}
