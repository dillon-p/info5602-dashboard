import { useEffect, useState } from 'react'
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type BubbleDataPoint,
  type ChartData,
  type ChartOptions,
  type Plugin,
  type TooltipItem,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { Bubble } from 'react-chartjs-2'
import { Line } from 'react-chartjs-2'
import './App.css'
import type { BlsDataset, BlsOccupation, BlsTrend, Exposure } from './types'

type Theme = 'light' | 'dark'

type TimelinePeriod = {
  startDate: string
  endDate: string
}

type TimelineSeries = {
  industry: string
  colorIndex: number
  values: Array<number | null>
  priorRates: Array<number | null>
  futureRates: Array<number | null>
  responseCounts: number[]
}

type TimelineData = {
  periods: TimelinePeriod[]
  series: TimelineSeries[]
}

type ChartPalette = {
  exposures: Record<Exposure, { fill: string; border: string }>
  grid: string
  axisText: string
  referenceLine: string
  annotationText: string
  annotationBackground: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
}

type BoxPlotSummary = {
  exposure: Exposure
  count: number
  q1: number
  median: number
  q3: number
  lowerWhisker: number
  upperWhisker: number
  outliers: Array<{ occupation: BlsOccupation; wage: number }>
}

ChartJS.register(BarElement, CategoryScale, LinearScale, LineElement, PointElement, Tooltip, Legend)
ChartJS.defaults.font.family = 'Montserrat, sans-serif'

const exposureOrder: Exposure[] = ['Very high', 'High', 'Moderate', 'Low']
const exposureColors: Record<Exposure, string> = {
  'Very high': 'rgb(184, 40, 105)',
  High: 'rgb(199, 79, 133)',
  Moderate: 'rgb(222, 146, 180)',
  Low: 'rgb(245, 225, 234)',
}

function getChartPalette(theme: Theme): ChartPalette {
  const outline = theme === 'dark' ? 'rgb(234 234 244)' : 'rgb(62 63 69)'

  return {
    exposures: {
      'Very high': { fill: exposureColors['Very high'], border: outline },
      High: { fill: exposureColors.High, border: outline },
      Moderate: { fill: exposureColors.Moderate, border: outline },
      Low: { fill: exposureColors.Low, border: outline },
    },
    grid: theme === 'dark' ? 'rgb(234 234 244 / 13%)' : 'rgb(0 0 0 / 8%)',
    axisText: theme === 'dark' ? '#fff' : 'rgb(62 63 69)',
    referenceLine: theme === 'dark' ? 'rgb(234 234 244)' : 'rgb(38 38 42)',
    annotationText: theme === 'dark' ? 'rgb(234 234 244)' : 'rgb(38 38 42)',
    annotationBackground: theme === 'dark' ? 'rgb(38 38 42)' : '#fff',
    tooltipBackground: theme === 'dark' ? 'rgb(62 63 69)' : 'rgb(234 234 244)',
    tooltipBorder: theme === 'dark' ? 'rgb(87 88 95)' : 'rgb(189 190 202)',
    tooltipText: theme === 'dark' ? 'rgb(255 255 255)' : 'rgb(38 38 42)',
  }
}

const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const axisNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const formatPercent = (value: number) => `${formatNumber.format(value)}%`
const formatAxisPercent = (value: number) => `${axisNumber.format(value)}%`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNumericValue(value: unknown): value is number | null | '—' {
  return value === null || value === '—' || (typeof value === 'number' && Number.isFinite(value))
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isExposure(value: unknown): value is Exposure {
  return typeof value === 'string' && exposureOrder.includes(value as Exposure)
}

function isTrend(value: unknown): value is BlsTrend {
  if (!isRecord(value)) return false

  const exposureKeys = [
    'General AI exposure',
    'General AI exposure_x',
    'General AI exposure_y',
  ] as const
  const hasExposureField = exposureKeys.some((key) => key in value)

  return (
    hasExposureField &&
    typeof value['Question ID'] === 'number' &&
    Number.isFinite(value['Question ID']) &&
    typeof value.Answer === 'string' &&
    isIsoDate(value.period_start_date) &&
    isIsoDate(value.period_end_date) &&
    (value.prior_rate === undefined ||
      value.prior_rate === null ||
      (typeof value.prior_rate === 'number' &&
        Number.isFinite(value.prior_rate) &&
        value.prior_rate >= 0 &&
        value.prior_rate <= 100)) &&
    (value.future_rate === undefined ||
      value.future_rate === null ||
      (typeof value.future_rate === 'number' &&
        Number.isFinite(value.future_rate) &&
        value.future_rate >= 0 &&
        value.future_rate <= 100)) &&
    (value['Industry title'] === undefined ||
      value['Industry title'] === null ||
      typeof value['Industry title'] === 'string') &&
    (value.rate === null ||
      (typeof value.rate === 'number' &&
        Number.isFinite(value.rate) &&
        value.rate >= 0 &&
        value.rate <= 100)) &&
    exposureKeys.every((key) => {
      const exposure = value[key]
      return exposure === undefined || exposure === null || typeof exposure === 'string'
    })
  )
}

function isOccupation(value: unknown): value is BlsOccupation {
  if (!isRecord(value)) return false

  return (
    typeof value['Occupation title'] === 'string' &&
    typeof value['SOC code'] === 'string' &&
    typeof value['Industry title'] === 'string' &&
    value['Industry title'].trim().length > 0 &&
    isNumericValue(value['Employment, 2035']) &&
    isNumericValue(value['Median annual wage, dollars, 2025']) &&
    isExposure(value['Relative AI exposure']) &&
    isNumericValue(value['Employment change, percent']) &&
    isNumericValue(value['Total occupational separations rate, annual average'])
  )
}

function isDataset(value: unknown): value is BlsDataset {
  if (!isRecord(value) || !Array.isArray(value.raw_data) || !Array.isArray(value.trends)) {
    return false
  }

  const metricsAreValid =
    value.metrics === undefined ||
    (Array.isArray(value.metrics) &&
      value.metrics.length === exposureOrder.length &&
      value.metrics.every(
        (metric) =>
          isRecord(metric) &&
          isExposure(metric['Relative AI exposure']) &&
          typeof metric.mean === 'number' &&
          Number.isFinite(metric.mean) &&
          typeof metric.median === 'number' &&
          Number.isFinite(metric.median),
      ) &&
      new Set(
        value.metrics.map((metric) =>
          isRecord(metric) ? metric['Relative AI exposure'] : undefined,
        ),
      ).size === exposureOrder.length)

  return (
    value.raw_data.every(isOccupation) &&
    value.trends.every(isTrend) &&
    metricsAreValid
  )
}

type PlotReadyOccupation = BlsOccupation & {
  'Employment change, percent': number
  'Total occupational separations rate, annual average': number
}

function hasChartValues(row: BlsOccupation): row is PlotReadyOccupation {
  return (
    typeof row['Employment change, percent'] === 'number' &&
    typeof row['Total occupational separations rate, annual average'] === 'number'
  )
}

function getTopIndustries(
  occupations: BlsOccupation[],
  eligibleIndustries: Set<string>,
  limit: number,
): string[] {
  const occupationsByIndustry = new Map<string, Set<string>>()
  for (const occupation of occupations) {
    const industryTitle = occupation['Industry title'].trim()
    const occupationCodes = occupationsByIndustry.get(industryTitle) ?? new Set()
    occupationCodes.add(occupation['SOC code'])
    occupationsByIndustry.set(industryTitle, occupationCodes)
  }

  return [...occupationsByIndustry]
    .filter(([industryTitle]) => eligibleIndustries.has(industryTitle))
    .sort(([titleA, codesA], [titleB, codesB]) =>
      codesB.size - codesA.size || titleA.localeCompare(titleB),
    )
    .slice(0, limit)
    .map(([industryTitle]) => industryTitle)
}

function getTimelineData(
  trends: BlsTrend[],
  industryTitles: string[],
  allIndustryTitles: string[],
): TimelineData {
  const selectedIndustries = new Set(industryTitles)
  const periods = new Map<
    string,
    {
      period: TimelinePeriod
      groups: Map<
        string,
        {
          rateSum: number
          rateCount: number
          priorRateSum: number
          priorRateCount: number
          futureRateSum: number
          futureRateCount: number
        }
      >
    }
  >()

  for (const response of trends) {
    if (response['Question ID'] !== 7 || response.Answer !== 'Yes') continue
    const industryTitle = response['Industry title']?.trim()
    if (!industryTitle || !selectedIndustries.has(industryTitle)) continue

    const key = `${response.period_start_date}/${response.period_end_date}`
    let period = periods.get(key)
    if (!period) {
      period = {
        period: {
          startDate: response.period_start_date,
          endDate: response.period_end_date,
        },
        groups: new Map(),
      }
      periods.set(key, period)
    }

    const group = period.groups.get(industryTitle) ?? {
      rateSum: 0,
      rateCount: 0,
      priorRateSum: 0,
      priorRateCount: 0,
      futureRateSum: 0,
      futureRateCount: 0,
    }
    if (response.rate !== null) {
      group.rateSum += response.rate
      group.rateCount += 1
    }
    if (typeof response.prior_rate === 'number') {
      group.priorRateSum += response.prior_rate
      group.priorRateCount += 1
    }
    if (typeof response.future_rate === 'number') {
      group.futureRateSum += response.future_rate
      group.futureRateCount += 1
    }
    period.groups.set(industryTitle, group)
  }

  const sortedPeriods = [...periods.values()].sort((a, b) =>
    a.period.startDate.localeCompare(b.period.startDate),
  )
  return {
    periods: sortedPeriods.map(({ period }) => period),
    series: industryTitles.map((industry) => ({
      industry,
      colorIndex: allIndustryTitles.indexOf(industry),
      values: sortedPeriods.map(({ groups }) => {
        const group = groups.get(industry)
        return group && group.rateCount > 0 ? group.rateSum / group.rateCount : null
      }),
      priorRates: sortedPeriods.map(({ groups }) => {
        const group = groups.get(industry)
        return group && group.priorRateCount > 0
          ? group.priorRateSum / group.priorRateCount
          : null
      }),
      futureRates: sortedPeriods.map(({ groups }) => {
        const group = groups.get(industry)
        return group && group.futureRateCount > 0
          ? group.futureRateSum / group.futureRateCount
          : null
      }),
      responseCounts: sortedPeriods.map(({ groups }) => groups.get(industry)?.rateCount ?? 0),
    })),
  }
}

function getIndustryColor(index: number, palette: ChartPalette): string {
  const hue = (index * 137.508) % 360
  const lightness = palette.axisText === '#fff' ? 65 : 42
  return `hsl(${hue} 68% ${lightness}%)`
}

const timelineAxisDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: '2-digit',
  timeZone: 'UTC',
})
const timelineTooltipDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

function getMedianSeparationRate(occupations: BlsOccupation[]): number | null {
  const rates = occupations
    .flatMap((occupation) => {
      const rate = occupation['Total occupational separations rate, annual average']
      return typeof rate === 'number' ? [rate] : []
    })
    .sort((a, b) => a - b)

  if (rates.length === 0) return null

  const middle = Math.floor(rates.length / 2)
  return rates.length % 2 === 0 ? (rates[middle - 1] + rates[middle]) / 2 : rates[middle]
}

function getNiceAxisScale(minValue: number, maxValue: number) {
  const range = maxValue > minValue ? maxValue - minValue : Math.max(Math.abs(minValue), 1)
  const rawStep = range / 8
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const stepSize = [1, 2, 5, 10]
    .map((factor) => factor * magnitude)
    .reduce((closest, candidate) =>
      Math.abs(candidate - rawStep) < Math.abs(closest - rawStep) ? candidate : closest,
    )
  const min = Math.floor(minValue / stepSize) * stepSize
  let max = Math.ceil(maxValue / stepSize) * stepSize
  if (max <= min) max = min + stepSize

  return {
    min: Number(min.toPrecision(12)),
    max: Number(max.toPrecision(12)),
    stepSize,
  }
}

function getQuantile(sortedValues: number[], quantile: number) {
  const position = (sortedValues.length - 1) * quantile
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const fraction = position - lowerIndex

  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction
}

function getBoxPlotSummaries(occupations: BlsOccupation[]): BoxPlotSummary[] {
  return exposureOrder.flatMap((exposure) => {
    const records = occupations
      .flatMap((occupation) => {
        const wage = occupation['Median annual wage, dollars, 2025']
        return occupation['Relative AI exposure'] === exposure && typeof wage === 'number'
          ? [{ occupation, wage }]
          : []
      })
      .sort((a, b) => a.wage - b.wage)
    if (records.length === 0) return []

    const wages = records.map(({ wage }) => wage)
    const q1 = getQuantile(wages, 0.25)
    const median = getQuantile(wages, 0.5)
    const q3 = getQuantile(wages, 0.75)
    const interquartileRange = q3 - q1
    const lowerFence = q1 - 1.5 * interquartileRange
    const upperFence = q3 + 1.5 * interquartileRange
    const lowerWhisker = records.find(({ wage }) => wage >= lowerFence)?.wage ?? wages[0]
    const upperWhisker =
      [...records].reverse().find(({ wage }) => wage <= upperFence)?.wage ?? wages[wages.length - 1]

    return [{
      exposure,
      count: records.length,
      q1,
      median,
      q3,
      lowerWhisker,
      upperWhisker,
      outliers: records.filter(({ wage }) => wage < lowerFence || wage > upperFence),
    }]
  })
}

type GrowthReadyOccupation = BlsOccupation & {
  'Employment change, percent': number
}

type EmploymentWageReadyOccupation = BlsOccupation & {
  'Employment, 2035': number
  'Median annual wage, dollars, 2025': number
}

function hasEmploymentAndWage(
  occupation: BlsOccupation,
): occupation is EmploymentWageReadyOccupation {
  return (
    typeof occupation['Employment, 2035'] === 'number' &&
    typeof occupation['Median annual wage, dollars, 2025'] === 'number'
  )
}

function getGrowthExtremes(occupations: BlsOccupation[]): GrowthReadyOccupation[] {
  const ranked = occupations
    .filter(
      (occupation): occupation is GrowthReadyOccupation =>
        typeof occupation['Employment change, percent'] === 'number',
    )
    .sort(
      (a, b) =>
        a['Employment change, percent'] - b['Employment change, percent'] ||
        a['Occupation title'].localeCompare(b['Occupation title']),
    )
  const lowest = ranked.slice(0, 5)
  const highest = ranked.slice(-5).reverse()
  const highestCodes = new Set(highest.map((occupation) => occupation['SOC code']))

  return [
    ...highest,
    ...lowest.filter((occupation) => !highestCodes.has(occupation['SOC code'])),
  ]
}

function getEmploymentChangeMetric(occupations: BlsOccupation[], exposure: Exposure) {
  const changes = occupations.flatMap((occupation) => {
    const change = occupation['Employment change, percent']
    return occupation['Relative AI exposure'] === exposure && typeof change === 'number'
      ? [change]
      : []
  })
    .sort((a, b) => a - b)

  if (changes.length === 0) return null

  const middle = Math.floor(changes.length / 2)
  const median =
    changes.length % 2 === 0
      ? (changes[middle - 1] + changes[middle]) / 2
      : changes[middle]

  return {
    mean: changes.reduce((sum, value) => sum + value, 0) / changes.length,
    median,
  }
}

function GrowthExtremesChart({
  occupations,
  palette,
}: {
  occupations: BlsOccupation[]
  palette: ChartPalette
}) {
  const extremes = getGrowthExtremes(occupations)
  const chartData: ChartData<'bar', number[], string> = {
    labels: extremes.map((occupation) => occupation['Occupation title']),
    datasets: [
      {
        label: 'Employment change',
        data: extremes.map((occupation) => occupation['Employment change, percent']),
        backgroundColor: extremes.map(
          (occupation) => palette.exposures[occupation['Relative AI exposure']].fill,
        ),
        borderColor: extremes.map(
          (occupation) => palette.exposures[occupation['Relative AI exposure']].border,
        ),
        borderWidth: 1,
        borderRadius: 4,
        barPercentage: 0.78,
        categoryPercentage: 0.9,
      },
    ],
  }
  const options: ChartOptions<'bar'> = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    color: palette.axisText,
    font: { family: 'Montserrat, sans-serif', size: 12 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        titleColor: palette.tooltipText,
        bodyColor: palette.tooltipText,
        callbacks: {
          title(items) {
            const occupation = extremes[items[0]?.dataIndex ?? -1]
            return occupation?.['Occupation title'] ?? ''
          },
          label(context: TooltipItem<'bar'>) {
            const occupation = extremes[context.dataIndex]
            if (!occupation) return ''

            return [
              `Employment change: ${formatPercent(occupation['Employment change, percent'])}`,
              `Relative AI exposure: ${occupation['Relative AI exposure']}`,
              `Industry: ${occupation['Industry title'].trim()}`,
            ]
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        title: { display: true, text: 'Expected employment change (%)', color: palette.axisText },
        ticks: { color: palette.axisText, callback: (value) => `${value}%` },
        grid: {
          color: (context) => (context.tick.value === 0 ? palette.referenceLine : palette.grid),
          lineWidth: (context) => (context.tick.value === 0 ? 1.5 : 1),
        },
        border: { display: false },
      },
      y: {
        type: 'category',
        reverse: false,
        ticks: { color: palette.axisText },
        grid: { display: false },
        border: { display: false },
      },
    },
  }

  return (
    <div
      className="chart-frame chart-frame--growth"
      role="img"
      aria-label="Horizontal bar chart showing the five occupations with the highest and lowest expected employment change rates. Bar colors indicate relative AI exposure."
    >
      {extremes.length > 0 ? (
        <Bar data={chartData} options={options} />
      ) : (
        <p className="empty-chart-message">No occupations with employment change data match this filter.</p>
      )}
    </div>
  )
}

function EmploymentWageScatterPlot({
  occupations,
  palette,
}: {
  occupations: BlsOccupation[]
  palette: ChartPalette
}) {
  const rowsByExposure: Record<Exposure, EmploymentWageReadyOccupation[]> = {
    'Very high': [],
    High: [],
    Moderate: [],
    Low: [],
  }

  for (const occupation of occupations) {
    if (hasEmploymentAndWage(occupation)) {
      rowsByExposure[occupation['Relative AI exposure']].push(occupation)
    }
  }

  const plottableOccupations = exposureOrder.flatMap((exposure) => rowsByExposure[exposure])
  if (plottableOccupations.length === 0) {
    return <p className="empty-chart-message">No employment and wage data matches this filter.</p>
  }

  const xScale = getNiceAxisScale(
    0,
    Math.max(...plottableOccupations.map((occupation) => occupation['Employment, 2035'])),
  )
  const yScale = getNiceAxisScale(
    0,
    Math.max(
      ...plottableOccupations.map(
        (occupation) => occupation['Median annual wage, dollars, 2025'],
      ),
    ),
  )
  const chartData: ChartData<'bubble', BubbleDataPoint[], string> = {
    datasets: exposureOrder.map((exposure) => ({
      label: exposure,
      data: rowsByExposure[exposure].map((occupation) => ({
        x: occupation['Employment, 2035'],
        y: occupation['Median annual wage, dollars, 2025'],
        r: 4,
      })),
      backgroundColor: palette.exposures[exposure].fill,
      borderColor: palette.exposures[exposure].border,
      borderWidth: 1,
      hoverBorderWidth: 2,
      hoverRadius: 3,
    })),
  }
  const options: ChartOptions<'bubble'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: true },
    color: palette.axisText,
    font: { family: 'Montserrat, sans-serif', size: 12 },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: palette.axisText,
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 18,
        },
      },
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        titleColor: palette.tooltipText,
        bodyColor: palette.tooltipText,
        callbacks: {
          title(items) {
            const exposure = exposureOrder.find(
              (category) => category === items[0]?.dataset.label,
            )
            const occupation =
              exposure === undefined
                ? undefined
                : rowsByExposure[exposure][items[0]?.dataIndex ?? -1]
            return occupation?.['Occupation title'] ?? ''
          },
          label(context: TooltipItem<'bubble'>) {
            const exposure = exposureOrder.find(
              (category) => category === context.dataset.label,
            )
            const occupation =
              exposure === undefined ? undefined : rowsByExposure[exposure][context.dataIndex]
            if (!occupation) return ''

            return [
              `Median annual wage: ${formatCompactCurrency(occupation['Median annual wage, dollars, 2025'])}`,
              `Projected employment in 2035: ${formatNumber.format(occupation['Employment, 2035'])} thousand`,
              `Industry: ${occupation['Industry title'].trim()}`,
              `Relative AI exposure: ${occupation['Relative AI exposure']}`,
            ]
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        min: xScale.min,
        max: xScale.max,
        title: {
          display: true,
          text: 'Projected employment in 2035 (thousands)',
          color: palette.axisText,
        },
        ticks: {
          color: palette.axisText,
          stepSize: xScale.stepSize,
          callback: (value) => formatNumber.format(Number(value)),
        },
        grid: { color: palette.grid },
        border: { display: false },
      },
      y: {
        type: 'linear',
        min: yScale.min,
        max: yScale.max,
        title: { display: true, text: 'Median annual wage (2025)', color: palette.axisText },
        ticks: {
          color: palette.axisText,
          stepSize: yScale.stepSize,
          callback: (value) => formatCompactCurrency(Number(value)),
        },
        grid: { color: palette.grid },
        border: { display: false },
      },
    },
  }

  return (
    <div
      className="chart-frame"
      role="img"
      aria-label="Scatter plot of 2035 projected employment and 2025 median annual wage for selected occupations. Color indicates relative AI exposure."
    >
      <Bubble data={chartData} options={options} />
    </div>
  )
}

function SectorTimelineChart({
  timeline,
  palette,
}: {
  timeline: TimelineData
  palette: ChartPalette
}) {
  const plottableRates = timeline.series.flatMap((series) =>
    series.values.filter((value): value is number => typeof value === 'number'),
  )

  if (plottableRates.length === 0) {
    return (
      <p className="empty-chart-message">
        No numeric Question 7 Yes rates are available for the selected industries.
      </p>
    )
  }

  const industryLabels: Plugin<'line'> = {
    id: 'industry-line-end-labels',
    afterDatasetsDraw(chart) {
      const labels: Array<{ industry: string; color: string; x: number; y: number }> = []
      timeline.series.forEach((series, datasetIndex) => {
        let dataIndex = series.values.length - 1
        while (dataIndex >= 0 && typeof series.values[dataIndex] !== 'number') dataIndex -= 1
        const point = chart.getDatasetMeta(datasetIndex).data[dataIndex]
        if (!point) return

        const { x, y } = point.getProps(['x', 'y'], true)
        labels.push({
          industry: series.industry,
          color: getIndustryColor(series.colorIndex, palette),
          x,
          y,
        })
      })
      if (labels.length === 0) return

      labels.sort((a, b) => a.y - b.y)
      const { top, bottom } = chart.chartArea
      const labelTop = top + 6
      const labelBottom = bottom - 6
      const gap = Math.min(13, (labelBottom - labelTop) / labels.length)
      const labelPositions = labels.map(({ y }) =>
        Math.max(labelTop, Math.min(labelBottom, y)),
      )
      for (let index = 1; index < labelPositions.length; index += 1) {
        labelPositions[index] = Math.max(labelPositions[index], labelPositions[index - 1] + gap)
      }
      if (labelPositions[labelPositions.length - 1] > labelBottom) {
        labelPositions[labelPositions.length - 1] = labelBottom
        for (let index = labelPositions.length - 2; index >= 0; index -= 1) {
          labelPositions[index] = Math.min(labelPositions[index], labelPositions[index + 1] - gap)
        }
      }

      const context = chart.ctx
      context.save()
      context.font = '600 10px Montserrat, sans-serif'
      context.textAlign = 'right'
      context.textBaseline = 'middle'
      context.lineWidth = 3.5
      context.lineJoin = 'round'
      context.strokeStyle = palette.annotationBackground
      labels.forEach((label, index) => {
        const x = Math.min(label.x - 6, chart.chartArea.right - 4)
        const y = labelPositions[index]
        context.strokeText(label.industry, x, y)
        context.fillStyle = label.color
        context.fillText(label.industry, x, y)
      })
      context.restore()
    },
  }

  const labels = timeline.periods.map(({ startDate }) =>
    timelineAxisDate.format(new Date(`${startDate}T00:00:00Z`)),
  )
  const maximumPercent = Math.max(...plottableRates)
  const yScale = getNiceAxisScale(0, Math.max(maximumPercent * 1.1, 1))
  const chartData: ChartData<'line', (number | null)[], string> = {
    labels,
    datasets: timeline.series.map((series) => {
      const color = getIndustryColor(series.colorIndex, palette)
      return {
        label: series.industry,
        data: series.values,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 8,
        pointBackgroundColor: color,
        pointBorderColor: color,
      }
    }),
  }
  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    color: palette.axisText,
    font: { family: 'Montserrat, sans-serif', size: 12 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        titleColor: palette.tooltipText,
        bodyColor: palette.tooltipText,
        callbacks: {
          title(items) {
            const period = timeline.periods[items[0]?.dataIndex ?? -1]
            if (!period) return ''

            const start = timelineTooltipDate.format(new Date(`${period.startDate}T00:00:00Z`))
            const end = timelineTooltipDate.format(new Date(`${period.endDate}T00:00:00Z`))
            return `${start} – ${end}`
          },
          label(context) {
            const series = timeline.series[context.datasetIndex]
            if (!series) return ''

            const rate = series.values[context.dataIndex]
            const priorRate = series.priorRates[context.dataIndex]
            const futureRate = series.futureRates[context.dataIndex]
            return [
              `${series.industry}: ${typeof rate === 'number' ? formatPercent(rate) : 'No estimate'}`,
              `Predicted rate from 6 months ago: ${typeof priorRate === 'number' ? formatPercent(priorRate) : 'No estimate'}`,
              `Future 6 months predicted rate: ${typeof futureRate === 'number' ? formatPercent(futureRate) : 'No estimate'}`,
            ]
          },
        },
      },
    },
    scales: {
      x: {
        type: 'category',
        title: { display: true, text: 'Survey period start', color: palette.axisText },
        ticks: {
          color: palette.axisText,
          maxTicksLimit: 12,
          maxRotation: 0,
          minRotation: 0,
          callback: (_value, index) => labels[index] ?? '',
        },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        type: 'linear',
        min: 0,
        max: yScale.max,
        title: { display: true, text: 'Q7 Yes rate (%)', color: palette.axisText },
        ticks: {
          color: palette.axisText,
          stepSize: yScale.stepSize,
          callback: (value) => formatAxisPercent(Number(value)),
        },
        grid: { color: palette.grid },
        border: { display: false },
      },
    },
  }

  return (
    <div
      className="chart-frame chart-frame--timeline"
      role="img"
      aria-label="Line chart showing Question 7 Yes rates over time by industry, with each line labeled by industry."
    >
      <Line data={chartData} options={options} plugins={[industryLabels]} />
    </div>
  )
}

function formatCompactCurrency(value: number) {
  if (value >= 1_000_000) {
    return `$${formatNumber.format(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `$${formatNumber.format(value / 1_000)}k`
  }
  return `$${formatNumber.format(value)}`
}

function BoxPlotChart({
  occupations,
  palette,
}: {
  occupations: BlsOccupation[]
  palette: ChartPalette
}) {
  const summaries = getBoxPlotSummaries(occupations)
  if (summaries.length === 0) {
    return <p className="empty-chart-message">No median annual wage data matches this filter.</p>
  }

  const width = 560
  const height = 380
  const margin = { top: 18, right: 12, bottom: 66, left: 58 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const maximumWage = Math.max(
    ...summaries.flatMap((summary) => [
      summary.upperWhisker,
      ...summary.outliers.map(({ wage }) => wage),
    ]),
  )
  const yScale = getNiceAxisScale(0, maximumWage)
  const yPosition = (value: number) =>
    margin.top + plotHeight - (value / yScale.max) * plotHeight
  const categoryWidth = plotWidth / exposureOrder.length
  const xPosition = (index: number) =>
    margin.left + categoryWidth * (index + 0.5)
  const tickCount = Math.floor(yScale.max / yScale.stepSize)
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index * yScale.stepSize)

  return (
    <div
      className="boxplot-scroll"
      role="img"
      aria-label="Boxplot comparing the distribution of 2025 median annual wages across the four relative AI exposure groups. Boxes show the interquartile range and median; whiskers extend to 1.5 times the interquartile range, and outliers are shown as points."
    >
      <svg
        className="boxplot-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="presentation"
        aria-hidden="true"
      >
        {ticks.map((tick) => {
          const y = yPosition(tick)
          return (
            <g key={tick}>
              <line
                x1={margin.left}
                x2={width - margin.right}
                y1={y}
                y2={y}
                stroke={palette.grid}
              />
              <text
                x={margin.left - 12}
                y={y + 4}
                fill={palette.axisText}
                textAnchor="end"
                className="boxplot-axis-label"
              >
                {formatCompactCurrency(tick)}
              </text>
            </g>
          )
        })}
        {summaries.map((summary) => {
          const index = exposureOrder.indexOf(summary.exposure)
          const center = xPosition(index)
          const boxWidth = Math.min(48, categoryWidth * 0.45)
          const boxTop = yPosition(summary.q3)
          const boxBottom = yPosition(summary.q1)
          const color = palette.exposures[summary.exposure]

          return (
            <g key={summary.exposure}>
              <title>
                {`${summary.exposure} exposure: n=${summary.count}; Q1 ${formatCompactCurrency(summary.q1)}; median ${formatCompactCurrency(summary.median)}; Q3 ${formatCompactCurrency(summary.q3)}; whiskers ${formatCompactCurrency(summary.lowerWhisker)}–${formatCompactCurrency(summary.upperWhisker)}; ${summary.outliers.length} outliers.`}
              </title>
              <line
                x1={center}
                x2={center}
                y1={yPosition(summary.upperWhisker)}
                y2={yPosition(summary.lowerWhisker)}
                stroke={color.border}
                strokeWidth={2}
              />
              <line
                x1={center - boxWidth * 0.28}
                x2={center + boxWidth * 0.28}
                y1={yPosition(summary.upperWhisker)}
                y2={yPosition(summary.upperWhisker)}
                stroke={color.border}
                strokeWidth={2}
              />
              <line
                x1={center - boxWidth * 0.28}
                x2={center + boxWidth * 0.28}
                y1={yPosition(summary.lowerWhisker)}
                y2={yPosition(summary.lowerWhisker)}
                stroke={color.border}
                strokeWidth={2}
              />
              <rect
                x={center - boxWidth / 2}
                y={boxTop}
                width={boxWidth}
                height={Math.max(boxBottom - boxTop, 1)}
                fill={color.fill}
                fillOpacity={0.75}
                stroke={color.border}
                strokeWidth={1.5}
              />
              <line
                x1={center - boxWidth / 2}
                x2={center + boxWidth / 2}
                y1={yPosition(summary.median)}
                y2={yPosition(summary.median)}
                stroke={palette.axisText}
                strokeWidth={2}
              />
              {summary.outliers.map(({ occupation, wage }, outlierIndex) => (
                <circle
                  key={occupation['SOC code']}
                  cx={center + ((outlierIndex % 7) - 3) * 3.2}
                  cy={yPosition(wage) + (Math.floor(outlierIndex / 7) % 2 === 0 ? 1 : -1)}
                  r={2.8}
                  fill={color.fill}
                  stroke={color.border}
                  strokeWidth={0.8}
                >
                  <title>
                    {`${occupation['Occupation title']}: ${formatCompactCurrency(wage)} annual median wage`}
                  </title>
                </circle>
              ))}
              <text
                x={center}
                y={height - margin.bottom + 22}
                fill={palette.axisText}
                textAnchor="middle"
                className="boxplot-category-label"
              >
                {summary.exposure}
              </text>
              <text
                x={center}
                y={height - margin.bottom + 39}
                fill={palette.axisText}
                textAnchor="middle"
                className="boxplot-sample-count"
              >
                n = {summary.count}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function ScatterPlot({
  occupations,
  allOccupations,
  medianSeparationRate,
  palette,
}: {
  occupations: BlsOccupation[]
  allOccupations: BlsOccupation[]
  medianSeparationRate: number | null
  palette: ChartPalette
}) {
  const rowsByExposure: Record<Exposure, PlotReadyOccupation[]> = {
    'Very high': [],
    High: [],
    Moderate: [],
    Low: [],
  }

  for (const occupation of occupations) {
    if (hasChartValues(occupation)) {
      rowsByExposure[occupation['Relative AI exposure']].push(occupation)
    }
  }

  const chartData: ChartData<'bubble', BubbleDataPoint[], string> = {
    datasets: exposureOrder.map((exposure) => ({
      label: exposure,
      data: rowsByExposure[exposure].map((occupation) => ({
        x: occupation['Total occupational separations rate, annual average'],
        y: occupation['Employment change, percent'],
        r: 5,
      })),
      backgroundColor: palette.exposures[exposure].fill,
      borderColor: palette.exposures[exposure].border,
      borderWidth: 1,
      hoverBorderWidth: 2,
    })),
  }

  const separationRates = allOccupations.flatMap((occupation) => {
    const rate = occupation['Total occupational separations rate, annual average']
    return typeof rate === 'number' ? [rate] : []
  })
  const maxRate = separationRates.length > 0 ? Math.max(...separationRates) : 0
  const xScale = getNiceAxisScale(0, maxRate)
  const employmentChanges = occupations.flatMap((occupation) => {
    const change = occupation['Employment change, percent']
    return typeof change === 'number' ? [change] : []
  })
  const minChange = employmentChanges.length > 0 ? Math.min(...employmentChanges) : 0
  const maxChange = employmentChanges.length > 0 ? Math.max(...employmentChanges) : 0
  const yScale = getNiceAxisScale(Math.min(minChange, 0), Math.max(maxChange, 0))
  const referenceLinesAndLabels: Plugin<'bubble'> = {
    id: 'scatter-reference-lines-and-quadrants',
    beforeDatasetsDraw(chart) {
      const { left, right, top, bottom } = chart.chartArea
      const context = chart.ctx
      context.save()
      context.beginPath()
      context.rect(left, top, right - left, bottom - top)
      context.clip()
      context.beginPath()
      context.setLineDash([6, 4])
      context.strokeStyle = palette.referenceLine
      context.lineWidth = 1.5
      if (medianSeparationRate !== null) {
        const x = chart.scales.x.getPixelForValue(medianSeparationRate)
        context.moveTo(x, top)
        context.lineTo(x, bottom)
      }
      const zeroY = chart.scales.y.getPixelForValue(0)
      context.moveTo(left, zeroY)
      context.lineTo(right, zeroY)
      context.stroke()
      context.restore()
    },
    afterDatasetsDraw(chart) {
      if (medianSeparationRate === null) return

      const { left, right, top, bottom } = chart.chartArea
      const medianX = chart.scales.x.getPixelForValue(medianSeparationRate)
      const zeroY = chart.scales.y.getPixelForValue(0)
      if (medianX < left || medianX > right || zeroY < top || zeroY > bottom) return

      const labels = [
        { lines: ['Growing with', 'Low Churn'], x: (left + medianX) / 2, y: top + 16 },
        { lines: ['Growing with', 'High Churn'], x: (medianX + right) / 2, y: top + 16 },
        { lines: ['Disappearing', 'Jobs'], x: (medianX + right) / 2, y: bottom - 20 },
        { lines: ['Declining with', 'Low Churn'], x: (left + medianX) / 2, y: bottom - 20 },
      ]

        const context = chart.ctx
        context.save()
        context.font = '600 11px Montserrat, sans-serif'
        context.textBaseline = 'middle'
        context.textAlign = 'center'
        context.lineWidth = 3
        context.lineJoin = 'round'
        context.strokeStyle = palette.annotationBackground
        context.fillStyle = palette.annotationText
        for (const label of labels) {
          const lineHeight = 12
          label.lines.forEach((line, index) => {
            const y = label.y + (index - (label.lines.length - 1) / 2) * lineHeight
            context.strokeText(line, label.x, y)
            context.fillText(line, label.x, y)
          })
        }
      context.restore()
    },
  }

  const options: ChartOptions<'bubble'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: true },
    color: palette.axisText,
    font: { family: 'Montserrat, sans-serif', size: 12 },
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          color: palette.axisText,
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 22,
        },
      },
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        titleColor: palette.tooltipText,
        bodyColor: palette.tooltipText,
        callbacks: {
          title(items) {
            const item = items[0]
            const exposure = exposureOrder.find(
              (category) => category === item?.dataset.label,
            )
            const occupation =
              exposure === undefined
                ? undefined
                : rowsByExposure[exposure][item?.dataIndex ?? -1]

            return occupation
              ? occupation['Occupation title']
              : ''
          },
          label(context: TooltipItem<'bubble'>) {
            const exposure = exposureOrder.find(
              (category) => category === context.dataset.label,
            )
            const occupation =
              exposure === undefined
                ? undefined
                : rowsByExposure[exposure][context.dataIndex]

            if (!occupation) return ''

            return [
              `Employment change: ${formatPercent(occupation['Employment change, percent'])}`,
              `Occupational separations rate: ${formatPercent(occupation['Total occupational separations rate, annual average'])}`,
              `Relative AI exposure: ${occupation['Relative AI exposure']}`,
            ]
          },
        },
      },
    },
    scales: {
      x: {
        type: 'linear',
        title: {
          display: true,
          text: 'Total occupational separations rate, annual average (%)',
          color: palette.axisText,
        },
        min: xScale.min,
        max: xScale.max,
        ticks: {
          color: palette.axisText,
          stepSize: xScale.stepSize,
          callback: (value) => formatAxisPercent(Number(value)),
        },
        grid: { color: palette.grid },
        border: { display: false },
      },
      y: {
        type: 'linear',
        title: { display: true, text: 'Employment change (%)', color: palette.axisText },
        min: yScale.min,
        max: yScale.max,
        ticks: {
          color: palette.axisText,
          stepSize: yScale.stepSize,
          callback: (value) => formatAxisPercent(Number(value)),
        },
        grid: { color: palette.grid },
        border: { display: false },
      },
    },
  }

  return (
    <div
      className="chart-frame"
      role="img"
      aria-label="Scatter plot of employment change and occupational separations rate by occupation. Color indicates relative AI exposure. All points are the same size."
    >
      <Bubble data={chartData} options={options} plugins={[referenceLinesAndLabels]} />
    </div>
  )
}

function App() {
  const [dataset, setDataset] = useState<BlsDataset | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [excludedIndustries, setExcludedIndustries] = useState<Set<string>>(() => new Set())
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem('dashboard-theme') === 'dark' ? 'dark' : 'light',
  )

  const chartPalette = getChartPalette(theme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dashboard-theme', theme)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#19191b' : '#f5f5f5')
  }, [theme])

  useEffect(() => {
    const controller = new AbortController()

    fetch(`${import.meta.env.BASE_URL}data/bls_ai_exposure.json`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`The BLS dataset could not be loaded (HTTP ${response.status}).`)
        }

        const payload: unknown = await response.json()
        if (!isDataset(payload)) {
          throw new Error('The BLS dataset has an unexpected format.')
        }
        setDataset(payload)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(
          error instanceof Error ? error.message : 'The BLS dataset could not be loaded.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [])

  const industryTitles = dataset
    ? [...new Set(dataset.raw_data.map((occupation) => occupation['Industry title'].trim()))].sort(
        (a, b) => a.localeCompare(b),
      )
    : []
  const visibleOccupations =
    dataset?.raw_data.filter(
      (occupation) => !excludedIndustries.has(occupation['Industry title'].trim()),
    ) ?? []
  const medianSeparationRate = dataset ? getMedianSeparationRate(dataset.raw_data) : null
  const timelineEligibleIndustries = new Set(
    dataset?.trends.flatMap((trend) => {
      const industryTitle = trend['Industry title']?.trim()
      return trend['Question ID'] === 7 &&
        trend.Answer === 'Yes' &&
        typeof trend.rate === 'number' &&
        industryTitle
        ? [industryTitle]
        : []
    }) ?? [],
  )
  const timelineIndustryTitles = dataset
    ? excludedIndustries.size > 0
      ? industryTitles.filter((title) => !excludedIndustries.has(title))
      : getTopIndustries(dataset.raw_data, timelineEligibleIndustries, 5)
    : []
  const timelineData = dataset
    ? getTimelineData(dataset.trends, timelineIndustryTitles, industryTitles)
    : null
  const plottableCount = visibleOccupations.filter(hasChartValues).length
  const selectedIndustryCount = industryTitles.filter(
    (title) => !excludedIndustries.has(title),
  ).length

  function toggleIndustry(title: string) {
    setExcludedIndustries((current) => {
      const next = new Set(current)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="How is AI Shaping the Workforce?">
          <span className="brand-mark" aria-hidden="true">AI</span>
        </a>
        <div className="header-actions">
          <span className="source-tag">A look at AI usage and job market trends</span>
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
        </div>
      </header>

      <section className="intro" id="top">
        <h1>How is AI Shaping the Workforce?</h1>
        <p className="intro-copy">
          A comparative look at projected employment changes, separations, wages and industry adoption of AI technologies.
          The data is sourced from the U.S. Bureau of Labor Statistics (BLS) and Census Business Trends and Outlook Survey (BTOS).
        </p>
      </section>

      <section className="chart-section" aria-label="Occupation snapshot">
        {loading && <div className="status-message" role="status">Loading the BLS dataset…</div>}
        {!loading && loadError && (
          <div className="status-message status-error" role="alert">{loadError}</div>
        )}
        {!loading && !loadError && dataset && (
          <>
            <div className="industry-filter-row">
              <details className="industry-filter">
                <summary>
                  <span>Industry Sector</span>
                  <span className="filter-summary">
                    {selectedIndustryCount === industryTitles.length
                      ? 'All industries'
                      : `${selectedIndustryCount} of ${industryTitles.length} selected`}
                  </span>
                </summary>
                <div className="industry-filter-panel">
                  <div className="filter-actions">
                    <button type="button" onClick={() => setExcludedIndustries(new Set())}>
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcludedIndustries(new Set(industryTitles))}
                    >
                      Clear all
                    </button>
                  </div>
                  <div className="industry-options" role="group" aria-label="Industry titles">
                    {industryTitles.map((title) => (
                      <label className="industry-option" key={title}>
                        <input
                          type="checkbox"
                          checked={!excludedIndustries.has(title)}
                          onChange={() => toggleIndustry(title)}
                        />
                        <span>{title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>
              <span className="data-count">
                {formatNumber.format(plottableCount)} occupations plotted
              </span>
            </div>
            <div className="charts-grid">
              <section className="visualization-panel" aria-labelledby="growth-chart-title">
                <div className="visualization-heading">
                  <p className="eyebrow">GROWTH EXTREMES</p>
                  <h2 id="growth-chart-title">Highest and lowest expected employment growth</h2>
                  <p>Five highest and lowest expected employment change rates in the selected industries.</p>
                </div>
                <div className="chart-card">
                  <GrowthExtremesChart occupations={visibleOccupations} palette={chartPalette} />
                  <div className="exposure-legend" aria-label="AI exposure legend">
                    {exposureOrder.map((exposure) => (
                      <span key={exposure}>
                        <i
                          style={{
                            backgroundColor: chartPalette.exposures[exposure].fill,
                            borderColor: chartPalette.exposures[exposure].border,
                          }}
                        />
                        {exposure}
                      </span>
                    ))}
                  </div>
                </div>
              </section>

              <section className="visualization-panel" aria-labelledby="scatter-chart-title">
                <div className="visualization-heading">
                  <p className="eyebrow">OCCUPATION GROWTH VARIATIONS</p>
                  <h2 id="scatter-chart-title">Employment change vs separations</h2>
                  <p>Compare the U.S. BLS 2025-2035 occupation percent of change projections against the annual rate of folks leaving that occupation's workforce over that same period of time.</p>
                </div>
                <div className="chart-card">
                  <ScatterPlot
                    occupations={visibleOccupations}
                    allOccupations={dataset.raw_data}
                    medianSeparationRate={medianSeparationRate}
                    palette={chartPalette}
                  />
                  <p className="chart-note">
                    Dashed line: all-occupation median separation rate
                    {medianSeparationRate === null ? '' : ` (${formatPercent(medianSeparationRate)})`}.
                    It does not change with the industry filter.
                  </p>
                </div>
              </section>
            </div>

            {dataset.metrics && (
              <section className="metrics-section" aria-labelledby="metrics-title">
                <div className="metrics-heading">
                  <div>
                    <p className="eyebrow">SUPPLIED SUMMARY METRICS</p>
                    <h2 id="metrics-title">Employment growth by AI exposure</h2>
                  </div>
                  <p>Mean and median projected percent change from the dataset.</p>
                </div>
                <div className="metrics-grid">
                  {exposureOrder.map((exposure) => {
                    const metric = getEmploymentChangeMetric(visibleOccupations, exposure)

                    return (
                      <article className="metric-card" key={exposure}>
                        <h3>
                          <span
                            className="metric-dot"
                            style={{ backgroundColor: chartPalette.exposures[exposure].border }}
                          />
                          {exposure} exposure
                        </h3>
                        <div className="metric-values">
                          <p><span>Mean growth</span><strong>{metric ? formatPercent(metric.mean) : '—'}</strong></p>
                          <p><span>Median growth</span><strong>{metric ? formatPercent(metric.median) : '—'}</strong></p>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </section>

      <section className="chart-section timeline-section" aria-labelledby="sector-timeline-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">BUSINESS AI USE</p>
            <h2 id="sector-timeline-title">Sector self-reported use of AI over time.</h2>
            <p>The BTOS asks two questions, "In the last two weeks, has your business used AI in any of it's functions?" (Q7) and "In six months, do you expect your business to use AI in any of it's functions?" (28). These can be compared to see how well business are predicting their use.</p>
          </div>
        </div>

        {loading && (
          <div className="status-message" role="status">Loading the Question 7 timeline…</div>
        )}
        {!loading && loadError && (
          <div className="status-message status-error" role="alert">{loadError}</div>
        )}
        {!loading && !loadError && timelineData && (
          <div className="chart-card">
            <SectorTimelineChart timeline={timelineData} palette={chartPalette} />
            <p className="chart-note">
              By default, the chart shows the five industries with the most unique occupations
              among industries with numeric Question 7 Yes rates. Narrowing the Industry title
              filter switches the chart to its selected industries. Each value is the unweighted
              mean of numeric Question 7 Yes rates for that industry during the two-week survey
              period.
            </p>
          </div>
        )}
      </section>

      {dataset && !loading && !loadError && (
        <section
          className="chart-section boxplot-section"
          aria-label="Projected employment and wage charts"
        >
          <p className="eyebrow">2025 MEDIAN WAGES</p>
          <div className="wage-charts-grid">
            <section className="visualization-panel" aria-labelledby="top-wages-chart-title">
              <div className="visualization-heading">
                <p className="eyebrow">OCCUPATION SCATTER</p>
                <h2 id="top-wages-chart-title">Projected employment and median wage</h2>
                <p>2025 Median Wages against their projected job 2035 openings.</p>
              </div>
              <div className="chart-card">
                <EmploymentWageScatterPlot
                  occupations={visibleOccupations}
                  palette={chartPalette}
                />
              </div>
            </section>
            <section className="visualization-panel" aria-labelledby="wage-exposure-title">
              <div className="visualization-heading">
                <p className="eyebrow">WAGE DISTRIBUTION</p>
                <h2 id="wage-exposure-title">Median annual wages by AI exposure</h2>
                <p>Compare 2025 occupation wages across exposure groups.</p>
              </div>
              <div className="chart-card">
                <BoxPlotChart occupations={visibleOccupations} palette={chartPalette} />
                <div className="boxplot-legend" aria-label="Boxplot key">
                  <span><i className="boxplot-key-box" /> Middle 50% (Q1–Q3)</span>
                  <span><i className="boxplot-key-median" /> Median</span>
                  <span><i className="boxplot-key-whisker" /> Within 1.5× IQR</span>
                  <span><i className="boxplot-key-outlier" /> Outlier</span>
                </div>
                <p className="chart-note">
                  Each occupation is one observation. Whiskers extend to the most extreme values within
                  1.5× the interquartile range; points beyond them are outliers. Unavailable wages are
                  excluded.
                </p>
              </div>
            </section>
          </div>
        </section>
      )}

      <footer className="site-footer">
        <p>
          Source: U.S. Bureau of Labor Statistics, 2025 National Employment Matrix, with relative
          AI-exposure categories included in the supplied dataset.
        </p>
        <p>Additional source: U.S. Census Bureau, Business Trends and Outlook Survey, Sector.xlsx, Question 7.</p>
        <p>
          AI exposure is a category in this dataset—not a forecast that a job will disappear or a
          measure of an individual worker&apos;s risk.
        </p>
      </footer>
    </main>
  )
}

export default App
