export type Exposure = 'Very high' | 'High' | 'Moderate' | 'Low'
export type NumericValue = number | null | '—'

export type BlsOccupation = {
  'Occupation title': string
  'SOC code': string
  'Industry title': string
  'Employment, 2035': NumericValue
  'Median annual wage, dollars, 2025': NumericValue
  'Employment change, percent': NumericValue
  'Total occupational separations rate, annual average': NumericValue
  'Relative AI exposure': Exposure
}

export type BlsTrend = {
  'Question ID': number
  Answer: string
  period_start_date: string
  period_end_date: string
  rate: number | null
  prior_rate?: number | null
  future_rate?: number | null
  'Industry title'?: string | null
  'General AI exposure'?: string | null
  'General AI exposure_x'?: string | null
  'General AI exposure_y'?: string | null
}

export type ExposureMetric = {
  'Relative AI exposure': Exposure
  mean: number
  median: number
}

export type BlsDataset = {
  raw_data: BlsOccupation[]
  trends: BlsTrend[]
  metrics?: ExposureMetric[]
}
