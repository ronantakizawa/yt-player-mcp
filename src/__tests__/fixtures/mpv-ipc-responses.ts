export const successResponse = JSON.stringify({ error: 'success', data: null });
export const propertyResponse = (data: unknown) => JSON.stringify({ error: 'success', data });
export const errorResponse = (msg: string) => JSON.stringify({ error: msg });
