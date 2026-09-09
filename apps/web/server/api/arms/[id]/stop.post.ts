export default defineEventHandler(async (event) => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const client = supervisorClient(event);
  return relay(() => client.stop(armId));
});
