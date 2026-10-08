'use strict';

/** Distance in metres between two GPS points (haversine). */
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Which geofence (if any) a phone location is inside. A fence counts when the distance to its centre
 * is within its radius; the GPS accuracy is not added, so a vague fix can't reach a far-away office.
 * Returns { inside, nearest: { branch, distance } }.
 */
function matchGeofence(lat, lng, branches) {
  let nearest = null;
  for (const b of branches) {
    if (b.lat === null || b.lng === null || b.lat === undefined) continue;
    const distance = distanceM(lat, lng, Number(b.lat), Number(b.lng));
    if (!nearest || distance < nearest.distance) nearest = { branch: b, distance };
  }
  const inside = !!nearest && nearest.distance <= Number(nearest.branch.radius_m || 0);
  return { inside, nearest };
}

module.exports = { distanceM, matchGeofence };
