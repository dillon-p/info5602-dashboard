export type Facility = {
  registry_id: string
  name: string
  city: string
  county: string
  latitude: number | null
  longitude: number | null
}

export type Emission = {
  reporting_year: number
  registry_id: string
  program: string
  program_code?: string
  program_id: string
  pollutant: string
  annual_emission: number
  unit_of_measure: string
  nei_type: string
  nei_hap_voc_flag: string
}

export type Snapshot = {
  schema_version: 1
  generated_at: string | null
  minimum_reporting_year?: number
  source: string
  facility_count: number
  record_count: number
  facilities: Facility[]
  emissions: Emission[]
}
