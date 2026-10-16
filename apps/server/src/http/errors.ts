export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d)
export const unauthorized = (m = 'Faça login para continuar.') => new HttpError(401, m)
export const forbidden = (m = 'Você não tem permissão para esta ação.') => new HttpError(403, m)
export const notFound = (m = 'Registro não encontrado.') => new HttpError(404, m)
export const conflict = (m: string) => new HttpError(409, m)
