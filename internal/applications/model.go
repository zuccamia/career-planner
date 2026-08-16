package applications

// PostingSource is the minimum FetchPosting needs: a URL to fetch, an
// already-fetched raw string that short-circuits the fetch, and a locale for
// error-message translation.
type PostingSource struct {
	URL            string
	Raw            string
	OutputLanguage string
}

// JDExtractionInput is the JD-extraction wire shape. Mirrors the JSON body the
// browser POSTs to /api/applications/extract-job-description.
type JDExtractionInput struct {
	CompanyName       string
	RoleTitle         string
	JobPostingURL     string
	JobDescriptionRaw string
	OutputLanguage    string
}

func (in JDExtractionInput) posting() PostingSource {
	return PostingSource{URL: in.JobPostingURL, Raw: in.JobDescriptionRaw, OutputLanguage: in.OutputLanguage}
}
