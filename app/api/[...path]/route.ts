import { env } from 'cloudflare:workers';
import { handleApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

async function route(request: Request) {
  if (!env.DB) return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'O serviço de dados ainda está sendo preparado. Tente novamente em instantes.'}},{status:503,headers:{'Cache-Control':'no-store'}});
  return handleApi(request, env.DB, {bucket:env.BUCKET,jobToken:env.PORTO_JOB_TOKEN,allowHttpLan:env.PORTO_ALLOW_HTTP_LAN==='true'});
}

export { route as GET, route as POST };
