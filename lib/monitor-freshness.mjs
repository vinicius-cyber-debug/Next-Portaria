export function relativeEventTime(value, now) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return 'Horário indisponível';
  const age = now - time;
  if (age < -60000) return 'Horário à frente do relógio desta tela';
  if (age < 60000) return 'Há menos de 1 minuto';
  const [count, unit] =
    age < 3600000
      ? [Math.floor(age / 60000), 'minuto']
      : age < 86400000
        ? [Math.floor(age / 3600000), 'hora']
        : [Math.floor(age / 86400000), 'dia'];
  return 'Há ' + count + ' ' + unit + (count === 1 ? '' : 's');
}
export function monitorConnectionFresh(snapshot, now) {
  const age = now - Date.parse(snapshot?.lastSuccessAt ?? '');
  return snapshot?.status === 'connected' && Number.isFinite(age) && age >= -60000 && age <= 30000;
}
