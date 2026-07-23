package http

// Builds the dashboard view shown on the home page.

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/ngochoang/career-planner/internal/applications"
	"github.com/ngochoang/career-planner/internal/communications"
	"github.com/ngochoang/career-planner/internal/engineering_blogs"
)

const (
	dashboardActivityDays       = 30
	dashboardActivityVisibleDays = 14
)

type dashboardPipelineStage struct {
	Label       string
	Count       int
	StatusLabel string
	Width       int
	AccentClass string
	MutedClass  string
	FillColor   string
}

type dashboardSankeyNode struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Color        string `json:"color"`
	Value        int    `json:"value"`
	Depth        int    `json:"depth"`
	VerticalOrder int   `json:"verticalOrder"`
}

type dashboardSankeyLink struct {
	Source int `json:"source"`
	Target int `json:"target"`
	Value  int `json:"value"`
}

type dashboardSankeyData struct {
	Title string                `json:"title"`
	Nodes []dashboardSankeyNode `json:"nodes"`
	Links []dashboardSankeyLink `json:"links"`
}

type dashboardActivityDay struct {
	Date              time.Time
	Label             string
	AppliedCount      int
	ThreadEntryCount  int
	TechBlogCount     int
	TotalCount        int
	AppliedHeight     int
	ThreadEntryHeight int
	TechBlogHeight    int
}

type dashboardStageDefinition struct {
	Label       string
	Statuses    []string
	StatusLabel string
	AccentClass string
	MutedClass  string
	FillColor   string
}

// home renders top-level dashboard metrics and recently updated companies.
func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	companiesList, err := s.companies.List(r.Context())
	if err != nil {
		log.Printf("list companies: %v", err)
		http.Error(w, "could not load dashboard", http.StatusInternalServerError)
		return
	}

	pipelineStages := buildDashboardPipeline(r.Context(), s.applications)
	activityDays, activityTotals := buildDashboardActivitySeries(r.Context(), s.applications, s.communications, s.engineeringBlogs, time.Now().UTC(), dashboardActivityDays)

	data := map[string]any{
		"Title":                 "Career Planner",
		"ActiveNav":             "home",
		"ApplicationsCount":     countApplicationsByStatus(r.Context(), s.applications),
		"CompaniesCount":        len(companiesList),
		"PipelineStages":        pipelineStages,
		"HasPipelineStages":     len(pipelineStages) > 0,
		"ActivityDays":          activityDays,
		"HasActivityDays":       len(activityDays) > 0,
		"ActivityWindowDays":    dashboardActivityDays,
		"ActivityVisibleDays":   dashboardActivityVisibleDays,
		"AppliedActivityTotal":  activityTotals.Applied,
		"ThreadActivityTotal":   activityTotals.ThreadEntries,
		"TechBlogActivityTotal": activityTotals.TechBlogs,
		"TotalActivityCount":    activityTotals.Total,
		"PipelineSankey":        buildDashboardPipelineSankey(r.Context(), s.applications, pipelineStages),
	}
	if err := s.render(w, r, "index.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func buildDashboardPipeline(ctx context.Context, service interface {
	CountByStatus(context.Context, string) (int, error)
}) []dashboardPipelineStage {
	definitions := dashboardStageDefinitions()
	stages := make([]dashboardPipelineStage, 0, len(definitions))
	totalCount := 0
	for _, definition := range definitions {
		count := 0
		for _, status := range definition.Statuses {
			count += countApplicationStatus(ctx, service, status)
		}
		if count == 0 {
			continue
		}
		totalCount += count
		stages = append(stages, dashboardPipelineStage{
			Label:       definition.Label,
			Count:       count,
			StatusLabel: definition.StatusLabel,
			AccentClass: definition.AccentClass,
			MutedClass:  definition.MutedClass,
			FillColor:   definition.FillColor,
		})
	}

	for i := range stages {
		stages[i].Width = scaledFunnelWidth(stages[i].Count, totalCount)
	}

	return stages
}

func buildDashboardPipelineSankey(ctx context.Context, service interface {
	ListStatusTransitionCounts(context.Context) ([]applications.StatusTransitionCount, error)
}, stages []dashboardPipelineStage) dashboardSankeyData {
	_ = stages
	type sankeyStatusDefinition struct {
		Status        string
		Label         string
		Color         string
		Depth         int
		VerticalOrder int
	}

	definitions := []sankeyStatusDefinition{
		{Status: "applied", Label: "Applied", Color: "#2563eb", Depth: 0, VerticalOrder: 2},
		{Status: "online_assessment", Label: "Assessment", Color: "#06b6d4", Depth: 1, VerticalOrder: 3},
		{Status: "first_interview", Label: "1st interview", Color: "#14b8a6", Depth: 2, VerticalOrder: 4},
		{Status: "second_interview", Label: "2nd interview", Color: "#84cc16", Depth: 3, VerticalOrder: 4},
		{Status: "additional_interview", Label: "Additional interview", Color: "#eab308", Depth: 4, VerticalOrder: 4},
		{Status: "offer", Label: "Offer", Color: "#a855f7", Depth: 5, VerticalOrder: 4},
		{Status: "withdrawn", Label: "Withdrawn", Color: "#a8a29e", Depth: 3, VerticalOrder: 1},
		{Status: "rejected", Label: "Rejected", Color: "#f43f5e", Depth: 6, VerticalOrder: 0},
	}

	definitionByStatus := make(map[string]sankeyStatusDefinition, len(definitions))
	statusOrder := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		definitionByStatus[definition.Status] = definition
		statusOrder = append(statusOrder, definition.Status)
	}

	transitions, err := service.ListStatusTransitionCounts(ctx)
	if err != nil {
		log.Printf("list dashboard status transitions: %v", err)
		return dashboardSankeyData{}
	}

	type transitionKey struct {
		From string
		To   string
	}
	aggregated := make(map[transitionKey]int)
	nodeStatuses := make(map[string]struct{})
	valueByStatus := make(map[string]int)
	for _, transition := range transitions {
		fromDefinition, fromOK := definitionByStatus[transition.FromStatus]
		toDefinition, toOK := definitionByStatus[transition.ToStatus]
		if !fromOK || !toOK || transition.Count <= 0 {
			continue
		}
		if transition.FromStatus == transition.ToStatus {
			continue
		}
		aggregated[transitionKey{From: transition.FromStatus, To: transition.ToStatus}] += transition.Count
		nodeStatuses[transition.FromStatus] = struct{}{}
		nodeStatuses[transition.ToStatus] = struct{}{}
		valueByStatus[fromDefinition.Status] += transition.Count
		valueByStatus[toDefinition.Status] += transition.Count
	}

	if len(aggregated) == 0 {
		return dashboardSankeyData{}
	}

	nodes := make([]dashboardSankeyNode, 0, len(nodeStatuses))
	indexByStatus := make(map[string]int, len(nodeStatuses))
	for _, status := range statusOrder {
		if _, ok := nodeStatuses[status]; !ok {
			continue
		}
		definition := definitionByStatus[status]
		indexByStatus[status] = len(nodes)
		nodes = append(nodes, dashboardSankeyNode{
			ID:            status,
			Name:          definition.Label,
			Color:         definition.Color,
			Value:         valueByStatus[status],
			Depth:         definition.Depth,
			VerticalOrder: definition.VerticalOrder,
		})
	}

	links := make([]dashboardSankeyLink, 0, len(aggregated))
	for _, fromStatus := range statusOrder {
		for _, toStatus := range statusOrder {
			count := aggregated[transitionKey{From: fromStatus, To: toStatus}]
			if count <= 0 {
				continue
			}
			links = append(links, dashboardSankeyLink{
				Source: indexByStatus[fromStatus],
				Target: indexByStatus[toStatus],
				Value:  count,
			})
		}
	}

	return dashboardSankeyData{Nodes: nodes, Links: links}
}

type dashboardActivityTotals struct {
	Applied       int
	ThreadEntries int
	TechBlogs     int
	Total         int
}

func dashboardStageLabelForStatus(status string) string {
	switch status {
	case "wishlist":
		return "Wishlist"
	case "applied":
		return "Applied"
	case "online_assessment":
		return "Assessment"
	case "first_interview", "second_interview", "additional_interview":
		return "Interviews"
	case "offer":
		return "Offer"
	case "rejected", "withdrawn":
		return "Closed"
	default:
		return ""
	}
}

func dashboardStageDefinitions() []dashboardStageDefinition {
	return []dashboardStageDefinition{
		{Label: "Wishlist", Statuses: []string{"wishlist"}, StatusLabel: "wishlist", AccentClass: "bg-slate-700", MutedClass: "bg-slate-200", FillColor: "#334155"},
		{Label: "Applied", Statuses: []string{"applied"}, StatusLabel: "applied", AccentClass: "bg-blue-600", MutedClass: "bg-blue-100", FillColor: "#2563eb"},
		{Label: "Assessment", Statuses: []string{"online_assessment"}, StatusLabel: "online assessment", AccentClass: "bg-cyan-500", MutedClass: "bg-cyan-100", FillColor: "#06b6d4"},
		{Label: "Interviews", Statuses: []string{"first_interview", "second_interview", "additional_interview"}, StatusLabel: "1st, 2nd, additional", AccentClass: "bg-amber-500", MutedClass: "bg-amber-100", FillColor: "#f59e0b"},
		{Label: "Offer", Statuses: []string{"offer"}, StatusLabel: "offer", AccentClass: "bg-emerald-500", MutedClass: "bg-emerald-100", FillColor: "#10b981"},
		{Label: "Closed", Statuses: []string{"rejected", "withdrawn"}, StatusLabel: "rejected, withdrawn", AccentClass: "bg-rose-500", MutedClass: "bg-rose-100", FillColor: "#f43f5e"},
	}
}

func countApplicationStatus(ctx context.Context, service interface {
	CountByStatus(context.Context, string) (int, error)
}, status string) int {
	if service == nil {
		return 0
	}
	count, err := service.CountByStatus(ctx, status)
	if err != nil {
		log.Printf("count application status for dashboard: %v", err)
		return 0
	}
	return count
}

func buildDashboardActivitySeries(
	ctx context.Context,
	applicationsService interface {
		ListDailyAppliedCounts(context.Context, time.Time, time.Time) ([]applications.DailyCount, error)
	},
	communicationsService interface {
		ListDailyEntryCounts(context.Context, time.Time, time.Time) ([]communications.DailyCount, error)
	},
	engineeringBlogsService interface {
		ListDailyCreatedCounts(context.Context, time.Time, time.Time) ([]engineering_blogs.DailyCount, error)
	},
	now time.Time,
	dayCount int,
) ([]dashboardActivityDay, dashboardActivityTotals) {
	if dayCount <= 0 {
		return []dashboardActivityDay{}, dashboardActivityTotals{}
	}

	resetWindow := func(start time.Time) ([]dashboardActivityDay, map[string]*dashboardActivityDay) {
		days := make([]dashboardActivityDay, 0, dayCount)
		dayIndex := make(map[string]*dashboardActivityDay, dayCount)
		for i := 0; i < dayCount; i++ {
			day := start.AddDate(0, 0, i)
			entry := dashboardActivityDay{
				Date:  day,
				Label: day.Format("Jan 2"),
			}
			days = append(days, entry)
			dayIndex[day.Format("2006-01-02")] = &days[len(days)-1]
		}
		return days, dayIndex
	}
	loadCounts := func(start, end time.Time) ([]applications.DailyCount, []communications.DailyCount, []engineering_blogs.DailyCount) {
		var (
			applicationCounts   []applications.DailyCount
			communicationCounts []communications.DailyCount
			blogCounts          []engineering_blogs.DailyCount
		)
		if applicationsService != nil {
			counts, err := applicationsService.ListDailyAppliedCounts(ctx, start, end)
			if err != nil {
				log.Printf("list daily applied counts for dashboard: %v", err)
			} else {
				applicationCounts = counts
			}
		}
		if communicationsService != nil {
			counts, err := communicationsService.ListDailyEntryCounts(ctx, start, end)
			if err != nil {
				log.Printf("list daily communication entry counts for dashboard: %v", err)
			} else {
				communicationCounts = counts
			}
		}
		if engineeringBlogsService != nil {
			counts, err := engineeringBlogsService.ListDailyCreatedCounts(ctx, start, end)
			if err != nil {
				log.Printf("list daily engineering blog counts for dashboard: %v", err)
			} else {
				blogCounts = counts
			}
		}
		return applicationCounts, communicationCounts, blogCounts
	}
	latestDayFromCounts := func(applicationCounts []applications.DailyCount, communicationCounts []communications.DailyCount, blogCounts []engineering_blogs.DailyCount) time.Time {
		latest := time.Time{}
		consider := func(day time.Time) {
			day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)
			if latest.IsZero() || day.After(latest) {
				latest = day
			}
		}
		for _, item := range applicationCounts {
			consider(item.Day)
		}
		for _, item := range communicationCounts {
			consider(item.Day)
		}
		for _, item := range blogCounts {
			consider(item.Day)
		}
		return latest
	}

	endDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := endDay.AddDate(0, 0, -(dayCount - 1))
	end := endDay.AddDate(0, 0, 1)

	totals := dashboardActivityTotals{}
	days, dayIndex := resetWindow(start)

	maxCount := 0
	applyApplicationCounts := func(items []applications.DailyCount, assign func(*dashboardActivityDay, int)) {
		for _, item := range items {
			key := item.Day.UTC().Format("2006-01-02")
			day := dayIndex[key]
			if day == nil {
				continue
			}
			assign(day, item.Count)
			if item.Count > maxCount {
				maxCount = item.Count
			}
		}
	}
	applyCommunicationCounts := func(items []communications.DailyCount, assign func(*dashboardActivityDay, int)) {
		for _, item := range items {
			key := item.Day.UTC().Format("2006-01-02")
			day := dayIndex[key]
			if day == nil {
				continue
			}
			assign(day, item.Count)
			if item.Count > maxCount {
				maxCount = item.Count
			}
		}
	}
	applyEngineeringBlogCounts := func(items []engineering_blogs.DailyCount, assign func(*dashboardActivityDay, int)) {
		for _, item := range items {
			key := item.Day.UTC().Format("2006-01-02")
			day := dayIndex[key]
			if day == nil {
				continue
			}
			assign(day, item.Count)
			if item.Count > maxCount {
				maxCount = item.Count
			}
		}
	}

	applicationCounts, communicationCounts, blogCounts := loadCounts(start, end)
	if !dashboardActivityHasAnyCounts(days) {
		discoveryStart := now.AddDate(-2, 0, 0)
		discoveryApplicationCounts, discoveryCommunicationCounts, discoveryBlogCounts := loadCounts(discoveryStart, end)
		if latest := latestDayFromCounts(discoveryApplicationCounts, discoveryCommunicationCounts, discoveryBlogCounts); !latest.IsZero() {
		start = latest.AddDate(0, 0, -(dayCount - 1))
		end = latest.AddDate(0, 0, 1)
		days, dayIndex = resetWindow(start)
		applicationCounts, communicationCounts, blogCounts = loadCounts(start, end)
		}
	}

	applyApplicationCounts(applicationCounts, func(day *dashboardActivityDay, count int) {
		day.AppliedCount = count
		totals.Applied += count
	})
	applyCommunicationCounts(communicationCounts, func(day *dashboardActivityDay, count int) {
		day.ThreadEntryCount = count
		totals.ThreadEntries += count
	})
	applyEngineeringBlogCounts(blogCounts, func(day *dashboardActivityDay, count int) {
		day.TechBlogCount = count
		totals.TechBlogs += count
	})

	for i := range days {
		days[i].TotalCount = days[i].AppliedCount + days[i].ThreadEntryCount + days[i].TechBlogCount
		totals.Total += days[i].TotalCount
		days[i].AppliedHeight = scaledBarHeight(days[i].AppliedCount, maxCount)
		days[i].ThreadEntryHeight = scaledBarHeight(days[i].ThreadEntryCount, maxCount)
		days[i].TechBlogHeight = scaledBarHeight(days[i].TechBlogCount, maxCount)
	}

	return days, totals
}

func dashboardActivityHasAnyCounts(days []dashboardActivityDay) bool {
	for _, day := range days {
		if day.AppliedCount > 0 || day.ThreadEntryCount > 0 || day.TechBlogCount > 0 {
			return true
		}
	}
	return false
}

func scaledBarHeight(count, maxCount int) int {
	if count <= 0 || maxCount <= 0 {
		return 0
	}
	height := int(float64(count) / float64(maxCount) * 100)
	if height < 8 {
		return 8
	}
	if height > 100 {
		return 100
	}
	return height
}

func scaledFunnelWidth(count, totalCount int) int {
	if totalCount <= 0 {
		return 28
	}
	if count <= 0 {
		return 28
	}
	width := int(float64(count) / float64(totalCount) * 100)
	if width < 28 {
		return 28
	}
	if width > 100 {
		return 100
	}
	return width
}

func countApplicationsByStatus(ctx context.Context, service interface {
	Count(context.Context) (int, error)
	CountByStatus(context.Context, string) (int, error)
}, status ...string) int {
	if service == nil {
		return 0
	}
	var (
		count int
		err   error
	)
	if len(status) == 0 {
		count, err = service.Count(ctx)
	} else {
		count, err = service.CountByStatus(ctx, status[0])
	}
	if err != nil {
		log.Printf("count applications for dashboard: %v", err)
		return 0
	}
	return count
}
