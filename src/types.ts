export type Exposure = 'Very high' | 'High' | 'Moderate' | 'Low'
export type NumericValue = number | null | '—'

export type BlsOccupation = {
  'Occupation title': string
  'SOC code': string
  'Industry title': string
  'Median annual wage, dollars, 2025': NumericValue
  'Employment change, percent': NumericValue
  'Total occupational separations rate, annual average': NumericValue
  'Relative AI exposure': Exposure
}

export type ExposureMetric = {
  'Relative AI exposure': Exposure
  mean: number
  median: number
}

export type BlsDataset = {
  raw_data: BlsOccupation[]
  metrics?: ExposureMetric[]
}
