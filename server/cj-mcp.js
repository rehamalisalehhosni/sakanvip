import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function cjEndpoint(){
  const token=process.env.CJ_MCP_TOKEN;
  if(!token) throw new Error('CJ_MCP_TOKEN is not configured');
  return new URL('https://developers.cjdropshipping.com/mcp/'+encodeURIComponent(token));
}
async function withCjClient(fn){
  const client=new Client({name:'sakanvip-backend',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(cjEndpoint());
  try{await client.connect(transport);return await fn(client);}
  finally{try{await transport.close();}catch{}}
}
export async function listCjTools(){
  return withCjClient(async client=>{
    const response=await client.listTools();
    return response.tools||[];
  });
}
export async function callCjTool(name,args){
  return withCjClient(async client=>{
    const response=await client.callTool({name,arguments:args});
    if(response.isError) throw new Error('CJ MCP returned a tool error');
    return response;
  });
}
