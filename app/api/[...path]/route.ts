import { getResources } from 'virtual:portaria-resources';
import { handleApi } from '../../../lib/server';

export const dynamic = 'force-dynamic';

async function route(request: Request) {
  const resources=getResources();
  if (!resources.db) return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'O serviço de dados ainda está sendo preparado. Tente novamente em instantes.'}},{status:503,headers:{'Cache-Control':'no-store'}});
  return handleApi(request, resources.db, resources);
}

export { route as GET, route as POST, route as PUT, route as DELETE, route as HEAD };
