export default defineEventHandler(async (event) => {
  const client = supervisorClient(event);
  return relay(() => client.inventory());
});
