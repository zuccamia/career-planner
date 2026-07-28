#set page(paper: "us-letter", margin: (x: 1in, y: 0.9in))
#set text(font: "New Computer Modern", size: 10pt)
#set par(justify: true, leading: 0.55em)

#align(center)[
  #text(size: 20pt, weight: "bold")[Nova Hoang] \
  #text(size: 9pt)[
    Backend engineer · nova.hoang\@example.com · github.com/novahoang
  ]
]

#v(0.3em)
#line(length: 100%, stroke: 0.5pt + gray)

== Summary

Six years of backend engineering with a focus on data pipelines and ingestion
systems. Comfortable owning services end-to-end from schema to deploy.

== Experience

*Stripe* — Senior Software Engineer #h(1fr) 2021 – present
- Rebuilt the ingestion pipeline for merchant transaction data; cut
  end-to-end latency from 22 minutes to under 4 minutes for the top 10
  services.
- Owned migration of 40+ services from batch to streaming ingestion,
  using Kafka + a custom framework upstreamed to opentelemetry-go.
- Mentored two junior engineers through their first production incidents.

*Rippling* — Software Engineer #h(1fr) 2019 – 2021
- Shipped the payroll amendments feature end-to-end; used by ~30% of
  active customers in the first quarter.
- Wrote the internal migration guide teams still reference today.

== Education

*Northeastern University* — B.S. Computer Science #h(1fr) 2015 – 2019
