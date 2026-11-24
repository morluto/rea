/** Whether a reported HTTP status is in the successful (2xx) class. */
export const isSuccessfulHttpStatus = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;
