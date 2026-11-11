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
import type { BlsDataset, BlsOccupation, Exposure } from './types'

type Theme = 'light' | 'dark'

type SectorTimelinePoint = {
  year: number
  week: number
  yesPercent: number | null
  availableSectorCount: number
  lowConfidenceSectorCount: number
}

type SectorTimelineData = {
  schemaVersion: 1
  questionId: 7
  question: string
  sectorCount: number
  weeks: SectorTimelinePoint[]
}

type ChartPalette = {
  exposures: Record<Exposure, { fill: string; border: string }>
  grid: string
  axisText: string
  timelineLine: string
  lowConfidence: string
  referenceLine: string
  annotationText: string
  annotationBackground: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
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
    timelineLine: theme === 'dark' ? 'rgb(105 168 255)' : 'rgb(29 99 196)',
    lowConfidence: theme === 'dark' ? 'rgb(245 153 197)' : 'rgb(137 28 79)',
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

function isExposure(value: unknown): value is Exposure {
  return typeof value === 'string' && exposureOrder.includes(value as Exposure)
}

function isOccupation(value: unknown): value is BlsOccupation {
  if (!isRecord(value)) return false

  return (
    typeof value['Occupation title'] === 'string' &&
    typeof value['SOC code'] === 'string' &&
    typeof value['Industry title'] === 'string' &&
    value['Industry title'].trim().length > 0 &&
    isExposure(value['Relative AI exposure']) &&
    isNumericValue(value['Employment change, percent']) &&
    isNumericValue(value['Total occupational separations rate, annual average'])
  )
}

function isDataset(value: unknown): value is BlsDataset {
  if (!isRecord(value) || !Array.isArray(value.raw_data)) {
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
    metricsAreValid
  )
}

function isSectorTimeline(value: unknown): value is SectorTimelineData {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.questionId !== 7 ||
    typeof value.question !== 'string' ||
    typeof value.sectorCount !== 'number' ||
    !Number.isInteger(value.sectorCount) ||
    value.sectorCount <= 0 ||
    !Array.isArray(value.weeks)
  ) {
    return false
  }

  const sectorCount = value.sectorCount
  let previousWeek = 0
  return value.weeks.every((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.year !== 'number' ||
      !Number.isInteger(entry.year) ||
      typeof entry.week !== 'number' ||
      !Number.isInteger(entry.week) ||
      entry.week < 1 ||
      entry.week > 53 ||
      !(entry.yesPercent === null ||
        (typeof entry.yesPercent === 'number' &&
          Number.isFinite(entry.yesPercent) &&
          entry.yesPercent >= 0 &&
          entry.yesPercent <= 100)) ||
      typeof entry.availableSectorCount !== 'number' ||
      !Number.isInteger(entry.availableSectorCount) ||
      entry.availableSectorCount < 0 ||
      typeof entry.lowConfidenceSectorCount !== 'number' ||
      !Number.isInteger(entry.lowConfidenceSectorCount) ||
      entry.lowConfidenceSectorCount < 0 ||
      entry.availableSectorCount + entry.lowConfidenceSectorCount > sectorCount
    ) {
      return false
    }

    const currentWeek = entry.year * 100 + entry.week
    if (currentWeek <= previousWeek) return false
    previousWeek = currentWeek
    return true
  })
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

type GrowthReadyOccupation = BlsOccupation & {
  'Employment change, percent': number
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
        reverse: true,
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

function SectorTimelineChart({
  timeline,
  palette,
}: {
  timeline: SectorTimelineData
  palette: ChartPalette
}) {
  const plottableWeeks = timeline.weeks.filter(
    (week): week is SectorTimelinePoint & { yesPercent: number } =>
      typeof week.yesPercent === 'number',
  )

  if (plottableWeeks.length === 0) {
    return <p className="empty-chart-message">No numeric Question 7 Yes estimates are available.</p>
  }

  const labels = timeline.weeks.map(
    ({ year, week }) => `W${week} '${String(year).slice(-2)}`,
  )
  const maximumPercent = Math.max(...plottableWeeks.map((week) => week.yesPercent))
  const yScale = getNiceAxisScale(0, Math.max(maximumPercent * 1.1, 1))
  const chartData: ChartData<'line', (number | null)[], string> = {
    labels,
    datasets: [
      {
        label: 'Mean Yes response',
        data: timeline.weeks.map((week) => week.yesPercent),
        borderColor: palette.timelineLine,
        backgroundColor: palette.timelineLine,
        borderWidth: 2,
        tension: 0.2,
        spanGaps: false,
        pointRadius: timeline.weeks.map((week) => week.lowConfidenceSectorCount > 0 ? 5 : 3),
        pointHoverRadius: 7,
        pointBackgroundColor: timeline.weeks.map((week) =>
          week.lowConfidenceSectorCount > 0 ? palette.lowConfidence : palette.timelineLine,
        ),
        pointBorderColor: timeline.weeks.map((week) =>
          week.lowConfidenceSectorCount > 0 ? palette.lowConfidence : palette.timelineLine,
        ),
      },
    ],
  }
  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: true },
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
            const point = timeline.weeks[items[0]?.dataIndex ?? -1]
            return point ? `Week ${point.week}, ${point.year}` : ''
          },
          label(context) {
            const point = timeline.weeks[context.dataIndex]
            if (!point) return ''

            const lines = [
              `Unweighted mean: ${point.yesPercent === null ? 'No estimate' : formatPercent(point.yesPercent)}`,
              `${point.availableSectorCount} of ${timeline.sectorCount} sectors included`,
            ]
            if (point.lowConfidenceSectorCount > 0) {
              lines.push(
                `${point.lowConfidenceSectorCount} low-confidence estimate${point.lowConfidenceSectorCount === 1 ? '' : 's'} excluded`,
              )
            }
            return lines
          },
        },
      },
    },
    scales: {
      x: {
        type: 'category',
        title: { display: true, text: 'Collection week', color: palette.axisText },
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
        title: { display: true, text: 'Businesses answering “Yes” (%)', color: palette.axisText },
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
      aria-label="Line chart showing the unweighted average percentage of businesses answering yes to Question 7 across NAICS sectors over time. Weeks with low-confidence sector estimates are highlighted."
    >
      <Line data={chartData} options={options} />
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
  const [sectorTimeline, setSectorTimeline] = useState<SectorTimelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [timelineLoading, setTimelineLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [timelineLoadError, setTimelineLoadError] = useState('')
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

  useEffect(() => {
    const controller = new AbortController()

    fetch(`${import.meta.env.BASE_URL}data/sector_ai_adoption.json`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`The Question 7 timeline could not be loaded (HTTP ${response.status}).`)
        }

        const payload: unknown = await response.json()
        if (!isSectorTimeline(payload)) {
          throw new Error('The Question 7 timeline data has an unexpected format.')
        }
        setSectorTimeline(payload)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setTimelineLoadError(
          error instanceof Error ? error.message : 'The Question 7 timeline could not be loaded.',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setTimelineLoading(false)
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
        <a className="brand" href="#top">
          <span className="brand-mark" aria-hidden="true">AI</span>
          <span>How is AI Shaping the Workforce?</span>
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
        <p className="eyebrow"><span className="eyebrow-dot" /> BLS NATIONAL EMPLOYMENT MATRIX · 2025–35</p>
        <h1>How do job separations relate to employment change?</h1>
        <p className="intro-copy">
          Compare projected employment change with the total occupational separations rate.
          Each point represents an occupation, with color showing its relative AI exposure.
        </p>
      </section>

      <section className="chart-section" aria-labelledby="chart-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OCCUPATION SNAPSHOT</p>
            <h2 id="chart-title">Employment patterns by occupation</h2>
          </div>
          <span className="data-count">
            {formatNumber.format(plottableCount)} occupations plotted
          </span>
        </div>

        {loading && <div className="status-message" role="status">Loading the BLS dataset…</div>}
        {!loading && loadError && (
          <div className="status-message status-error" role="alert">{loadError}</div>
        )}
        {!loading && !loadError && dataset && (
          <>
            <details className="industry-filter">
              <summary>
                <span>Industry title</span>
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
                  <p className="eyebrow">OCCUPATION SCATTER</p>
                  <h2 id="scatter-chart-title">Employment change and separations</h2>
                  <p>Compare employment change against the average total occupational separations rate.</p>
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
            <p className="eyebrow">BUSINESS SI USE</p>
            <h2 id="sector-timeline-title">Business use of SI over time</h2>
          </div>
        </div>

        {timelineLoading && (
          <div className="status-message" role="status">Loading the Question 7 timeline…</div>
        )}
        {!timelineLoading && timelineLoadError && (
          <div className="status-message status-error" role="alert">{timelineLoadError}</div>
        )}
        {!timelineLoading && !timelineLoadError && sectorTimeline && (
          <div className="chart-card">
            <SectorTimelineChart timeline={sectorTimeline} palette={chartPalette} />
            <div className="timeline-legend" aria-label="Timeline legend">
              <span className="timeline-legend-item">
                <i className="timeline-legend-line" style={{ borderColor: chartPalette.timelineLine }} />
                Unweighted mean Yes response
              </span>
              <span className="timeline-legend-item">
                <i className="timeline-legend-point" style={{ backgroundColor: chartPalette.lowConfidence }} />
                At least one low-confidence sector estimate
              </span>
            </div>
            <p className="chart-note">
              Each point is the unweighted mean of available Yes percentages across 19 NAICS
              sectors; “XX” (multi-unit companies operating across multiple sectors or states) is
              excluded. Weeks containing “S” estimates are highlighted; those estimates are
              excluded from the mean. Weeks with only “.” values are omitted.
            </p>
          </div>
        )}
      </section>

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
