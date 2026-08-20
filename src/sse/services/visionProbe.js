export function isAuthorizedVisionProbe(body, headers, token) {
  return body?.metadata?.vision_probe === true
    && !!token
    && headers?.["x-9r-vision-probe"] === token;
}
