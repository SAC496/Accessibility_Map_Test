/**
 * census.js
 * Reads pre-fetched ambulatory disability data from window.DISABILITY_DATA,
 * which is populated by disability-data.js (generated via fetch-disability-data.js).
 *
 * Generate (or refresh) the data file:
 *   node fetch-disability-data.js
 *
 * Exposes: window.Census.fetchByZips(zips), window.Census.fetchByTracts()
 */
(function () {
  'use strict';

  function getData() {
    if (!window.DISABILITY_DATA) throw new Error(
      'disability-data.js not loaded. Run:  node fetch-disability-data.js'
    );
    return window.DISABILITY_DATA;
  }

  /**
   * Return disability counts for the given ZIP codes.
   * @param {string[]} zips — e.g. ["15201", "15213"]
   * @returns {Promise<Map<string, {count: number, totalPop: number}>>}
   */
  async function fetchByZips(zips) {
    const { zipcodes } = getData();
    const result = new Map();
    zips.forEach(zip => {
      if (zipcodes[zip]) result.set(zip, zipcodes[zip]);
    });
    return result;
  }

  /**
   * Return disability counts for all Allegheny County census tracts.
   * @returns {Promise<Map<string, {count: number, totalPop: number}>>}
   *   Keyed by 11-character GEOID.
   */
  async function fetchByTracts() {
    const { tracts } = getData();
    return new Map(Object.entries(tracts));
  }

  window.Census = { fetchByZips, fetchByTracts };
})();
