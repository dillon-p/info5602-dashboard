import { useEffect, useMemo, useState } from 'react'
import './App.css'
import type { Emission, Facility, Snapshot } from './types'

const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const formatInteger = new Intl.NumberFormat('en-US')

type Filters = {
  year: string
  program: string
  pollutant: string
  unit: string
}

type FacilityTotal = {
  facility: Facility
  unit: string
  total: number
  programs: Set<string>
  pollutants: Set<string>
  years: Set<number>
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Snapshot>
  return (
    candidate.schema_version === 1 &&
    Array.isArray(candidate.facilities) &&
    Array.isArray(candidate.emissions) &&
    candidate.facilities.every(
      (facility) =>
        typeof facility.registry_id === 'string' &&
        typeof facility.name === 'string' &&
        typeof facility.city === 'string' &&
        typeof facility.county === 'string',
    ) &&
    candidate.emissions.every(
      (record) =>
        typeof record.reporting_year === 'number' &&
        typeof record.registry_id === 'string' &&
        typeof record.program === 'string' &&
        typeof record.pollutant === 'string' &&
        typeof record.annual_emission === 'number' &&
        Number.isFinite(record.annual_emission) &&
        typeof record.unit_of_measure === 'string',
    )
  )
}

function optionValues(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function summarizeFacilities(records: Emission[], facilities: Map<string, Facility>) {
  const grouped = new Map<string, FacilityTotal>()

  for (const record of records) {
    const facility = facilities.get(record.registry_id)
    if (!facility) continue

    const key = `${record.registry_id}\u0000${record.unit_of_measure}`
    const current = grouped.get(key) ?? {
      facility,
      unit: record.unit_of_measure,
      total: 0,
      programs: new Set<string>(),
      pollutants: new Set<string>(),
      years: new Set<number>(),
    }

    current.total += record.annual_emission
    current.programs.add(record.program)
    current.pollutants.add(record.pollutant)
    current.years.add(record.reporting_year)
    grouped.set(key, current)
  }

  return [...grouped.values()]
}

function TrendChart({ records }: { records: Emission[] }) {
  const unitGroups = new Map<string, Map<number, number>>()

  for (const record of records) {
    const years = unitGroups.get(record.unit_of_measure) ?? new Map<number, number>()
    years.set(
      record.reporting_year,
      (years.get(record.reporting_year) ?? 0) + record.annual_emission,
    )
    unitGroups.set(record.unit_of_measure, years)
  }

  if (unitGroups.size === 0) {
    return <p className="empty-note">No emissions match these filters.</p>
  }

  return (
    <div className="trend-groups">
      {[...unitGroups.entries()]
        .sort(([unitA], [unitB]) => unitA.localeCompare(unitB))
        .map(([unit, yearTotals]) => {
          const years = [...yearTotals.keys()].sort((a, b) => a - b)
          const max = Math.max(...yearTotals.values(), 1)

          return (
            <section className="trend-group" key={unit} aria-label={`Emissions in ${unit}`}>
              <div className="trend-unit">{unit}</div>
              <div className="bar-chart">
                {years.map((year) => {
                  const value = yearTotals.get(year) ?? 0
                  const height = Math.max(3, (value / max) * 100)

                  return (
                    <div className="bar-column" key={year}>
                      <span className="bar-value">{formatNumber.format(value)}</span>
                      <div className="bar-track">
                        <div
                          className="bar"
                          style={{ height: `${height}%` }}
                          title={`${formatNumber.format(value)} ${unit} in ${year}`}
                        />
                      </div>
                      <span className="bar-year">{year}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
    </div>
  )
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filters, setFilters] = useState<Filters>({
    year: 'all',
    program: 'all',
    pollutant: 'all',
    unit: '',
  })

  useEffect(() => {
    const controller = new AbortController()

    fetch(`${import.meta.env.BASE_URL}data/colorado-emissions.json`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`The public data snapshot could not be loaded (HTTP ${response.status}).`)
        }
        return (await response.json()) as unknown
      })
      .then((data) => {
        if (!isSnapshot(data)) {
          throw new Error('The public data snapshot has an unexpected format.')
        }
        setSnapshot(data)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(error instanceof Error ? error.message : 'The public data snapshot could not be loaded.')
      })
      .finally(() => setLoading(false))

    return () => controller.abort()
  }, [])

  const facilityIndex = useMemo(
    () => new Map((snapshot?.facilities ?? []).map((facility) => [facility.registry_id, facility])),
    [snapshot],
  )
  const emissions = snapshot?.emissions ?? []
  const years = [...new Set(emissions.map((record) => record.reporting_year))].sort((a, b) => b - a)
  const programs = optionValues(emissions.map((record) => record.program))
  const pollutants = optionValues(emissions.map((record) => record.pollutant))
  const units = optionValues(emissions.map((record) => record.unit_of_measure))

  const unitCounts = new Map<string, number>()
  for (const record of emissions) {
    unitCounts.set(record.unit_of_measure, (unitCounts.get(record.unit_of_measure) ?? 0) + 1)
  }
  const defaultUnit = [...unitCounts.entries()].sort(
    ([unitA, countA], [unitB, countB]) => countB - countA || unitA.localeCompare(unitB),
  )[0]?.[0]
  const selectedUnit = filters.unit || defaultUnit || 'all'

  const filteredEmissions = emissions.filter(
    (record) =>
      (filters.year === 'all' || record.reporting_year.toString() === filters.year) &&
      (filters.program === 'all' || record.program === filters.program) &&
      (filters.pollutant === 'all' || record.pollutant === filters.pollutant) &&
      (selectedUnit === 'all' || record.unit_of_measure === selectedUnit),
  )

  const facilityTotals = summarizeFacilities(filteredEmissions, facilityIndex).sort((a, b) => {
    if (selectedUnit === 'all') {
      return a.facility.name.localeCompare(b.facility.name) || a.unit.localeCompare(b.unit)
    }
    return b.total - a.total || a.facility.name.localeCompare(b.facility.name)
  })
  const unitSet = new Set(filteredEmissions.map((record) => record.unit_of_measure))
  const totalEmissions =
    unitSet.size === 1
      ? filteredEmissions.reduce((sum, record) => sum + record.annual_emission, 0)
      : null
  const totalUnit = unitSet.size === 1 ? [...unitSet][0] : null
  const reportingYears = filteredEmissions.map((record) => record.reporting_year)
  const yearRange =
    reportingYears.length > 0
      ? `${reportingYears.reduce((min, year) => Math.min(min, year), Infinity)}–${reportingYears.reduce((max, year) => Math.max(max, year), -Infinity)}`
      : '—'
  const facilityCount = new Set(filteredEmissions.map((record) => record.registry_id)).size

  function updateFilter(key: keyof Filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Colorado emissions overview">
          <span className="brand-mark" aria-hidden="true">CO</span>
          <span>Colorado emissions atlas</span>
        </a>
        <a className="topbar-link" href="#about">About the data <span aria-hidden="true">↗</span></a>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <p className="eyebrow"><span className="eyebrow-dot" /> COLORADO · FACILITY-REPORTED AIR EMISSIONS</p>
          <h1>What Colorado facilities report to the EPA</h1>
          <p className="intro-description">
            Explore estimated air emissions by facility, pollutant, program, and reporting year.
            Each view keeps unlike units separate so comparisons stay clear.
          </p>
          <a className="text-link" href="#explore">Explore the data <span aria-hidden="true">↓</span></a>
        </div>
        <div className="intro-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <span className="mountain mountain-back" />
          <span className="mountain mountain-front" />
          <span className="sun" />
          <span className="art-label">CO</span>
        </div>
      </section>

      <section className="data-ribbon" aria-label="Snapshot information">
        <div className="ribbon-label"><span className="live-dot" /> ECHO AIR EMISSIONS DATA</div>
        <div className="ribbon-detail">
          {snapshot?.generated_at
            ? `Snapshot refreshed ${new Date(snapshot.generated_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}`
            : 'Waiting for the first successful data refresh'}
        </div>
        <div className="ribbon-source">EPA · EDGI ECHO Pipeline</div>
      </section>

      <section className="dashboard-section" id="explore">
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE DASHBOARD</p>
            <h2>Explore reported emissions</h2>
          </div>
          <p className="section-aside">Filter the data to focus on a particular year, reporting program, or pollutant.</p>
        </div>

        <div className="filter-panel">
          <div className="filter-heading">
            <span className="filter-icon" aria-hidden="true">⌘</span>
            <div>
              <h3>Refine your view</h3>
              <p>Every chart and total updates with your selections.</p>
            </div>
          </div>
          <div className="filter-controls">
            <label>
              <span>Reporting year</span>
              <select value={filters.year} onChange={(event) => updateFilter('year', event.target.value)}>
                <option value="all">All years</option>
                {years.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
            <label>
              <span>EPA program</span>
              <select value={filters.program} onChange={(event) => updateFilter('program', event.target.value)}>
                <option value="all">All programs</option>
                {programs.map((program) => <option key={program} value={program}>{program}</option>)}
              </select>
            </label>
            <label>
              <span>Pollutant</span>
              <select value={filters.pollutant} onChange={(event) => updateFilter('pollutant', event.target.value)}>
                <option value="all">All pollutants</option>
                {pollutants.map((pollutant) => <option key={pollutant} value={pollutant}>{pollutant}</option>)}
              </select>
            </label>
            <label>
              <span>Emissions unit</span>
              <select value={selectedUnit} onChange={(event) => updateFilter('unit', event.target.value)}>
                <option value="all">All units (shown separately)</option>
                {units.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </label>
          </div>
        </div>

        {loading && <div className="status-message" role="status">Loading the latest published snapshot…</div>}
        {!loading && loadError && <div className="status-message status-error" role="alert">{loadError}</div>}
        {!loading && !loadError && (snapshot?.emissions.length ?? 0) === 0 && (
          <div className="status-message" role="status">
            <strong>No public snapshot has been published yet.</strong>
            <span>Once the GitHub Actions refresh succeeds, Colorado facility emissions will appear here.</span>
          </div>
        )}

        {!loading && !loadError && (snapshot?.emissions.length ?? 0) > 0 && (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span className="metric-label">Facilities in view</span>
                <strong>{formatInteger.format(facilityCount)}</strong>
                <span className="metric-note">Colorado facilities with matching records</span>
              </article>
              <article className="metric-card">
                <span className="metric-label">Reported records</span>
                <strong>{formatInteger.format(filteredEmissions.length)}</strong>
                <span className="metric-note">Facility · pollutant · year entries</span>
              </article>
              <article className="metric-card metric-card-accent">
                <span className="metric-label">Estimated emissions</span>
                <strong>{totalEmissions === null ? 'Multiple units' : formatNumber.format(totalEmissions)}</strong>
                <span className="metric-note">
                  {totalEmissions === null
                    ? 'Select one unit to see a comparable total'
                    : totalUnit}
                </span>
              </article>
              <article className="metric-card">
                <span className="metric-label">Reporting years</span>
                <strong>{yearRange}</strong>
                <span className="metric-note">Years represented in this view</span>
              </article>
            </div>

            {filteredEmissions.length === 0 ? (
              <div className="status-message">
                <strong>No records match these filters.</strong>
                <span>Try a different year, program, pollutant, or unit.</span>
              </div>
            ) : (
              <div className="analysis-grid">
                <section className="content-card trend-card">
                  <div className="card-heading">
                    <div>
                      <p className="eyebrow">OVER TIME</p>
                      <h3>Reported emissions by year</h3>
                    </div>
                    <span className="card-icon" aria-hidden="true">↗</span>
                  </div>
                  <p className="card-description">
                    Annual reported values are grouped by unit. Each unit has its own scale.
                  </p>
                  <TrendChart records={filteredEmissions} />
                  <p className="chart-footnote">Reporting years differ by EPA program; a missing year does not mean zero emissions.</p>
                </section>

                <section className="content-card facility-card">
                  <div className="card-heading">
                    <div>
                      <p className="eyebrow">FACILITIES</p>
                      <h3>{selectedUnit === 'all' ? 'Facility totals by unit' : 'Largest reported totals'}</h3>
                    </div>
                    <span className="card-count">{facilityTotals.length}</span>
                  </div>
                  <p className="card-description">
                    {selectedUnit === 'all'
                      ? 'Rows with different units are kept separate and are not ranked against each other.'
                      : `Ranked within ${selectedUnit}; values combine the selected reporting years and filters.`}
                  </p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Facility</th>
                          <th scope="col">Pollutants</th>
                          <th scope="col">Years</th>
                          <th scope="col" className="numeric">Reported amount</th>
                          <th scope="col">Unit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {facilityTotals.slice(0, 20).map((row, index) => (
                          <tr key={`${row.facility.registry_id}-${row.unit}`}>
                            <td>
                              <div className="facility-name">
                                {selectedUnit !== 'all' && <span className="rank">{String(index + 1).padStart(2, '0')}</span>}
                                <span>
                                  <strong>{row.facility.name || 'Unnamed facility'}</strong>
                                  <small>{[row.facility.city, row.facility.county].filter(Boolean).join(' · ') || 'Colorado'}</small>
                                </span>
                              </div>
                            </td>
                            <td>{row.pollutants.size}</td>
                            <td>{row.years.size}</td>
                            <td className="numeric">{formatNumber.format(row.total)}</td>
                            <td><span className="unit-pill">{row.unit}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="table-footnote">
                    Totals sum reported values for a facility and unit; they are not a measure of relative health risk.
                  </p>
                </section>
              </div>
            )}
          </>
        )}
      </section>

      <section className="about-section" id="about">
        <div className="about-mark" aria-hidden="true">i</div>
        <div>
          <p className="eyebrow">READING THE DATA</p>
          <h2>Reported estimates, not direct measurements</h2>
          <p>
            ECHO combines facility-level data from EPA&apos;s National Emissions Inventory (NEI),
            Greenhouse Gas Reporting Program (GHGRP), Toxics Release Inventory (TRI), and Clean
            Air Markets (CAMD). Reporting schedules, pollutants, and units vary by program.
            Emissions are reported or estimated values—not a complete accounting of pollution or
            a direct measure of exposure, compliance, or health risk.
          </p>
          <a href="https://echo.epa.gov/tools/data-downloads/air-emissions-download-summary" target="_blank" rel="noreferrer">
            EPA Air Emissions data documentation <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <footer className="footer">
        <span>Colorado emissions atlas</span>
        <span>Data: <a href="https://echo.epa.gov/" target="_blank" rel="noreferrer">EPA ECHO</a> · Pipeline: <a href="https://github.com/edgi-govdata-archiving/ECHO-Pipeline" target="_blank" rel="noreferrer">EDGI</a></span>
      </footer>
    </main>
  )
}

export default App
