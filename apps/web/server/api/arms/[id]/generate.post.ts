export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const body = await readBody<unknown>(event);
  const client = supervisorClient(event);
  return relay(() => client.job(id, body));
});
