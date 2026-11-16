package com.petclinic.controller.client;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.DoctorQuery;
import com.petclinic.dto.PageQuery;
import com.petclinic.entity.Department;
import com.petclinic.entity.Notice;
import com.petclinic.service.DepartmentService;
import com.petclinic.service.DoctorReviewService;
import com.petclinic.service.DoctorScheduleService;
import com.petclinic.service.DoctorService;
import com.petclinic.service.NoticeService;
import com.petclinic.vo.DoctorVo;
import com.petclinic.vo.HomeVo;
import com.petclinic.vo.ReviewVo;
import com.petclinic.vo.ScheduleVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;

/**
 * 公开浏览区：不登录也能看科室、医生、号源、公告。
 *
 * 整个前缀挂在 WebMvcConfig 的白名单里，所以这里新增接口必须是只读的——
 * 任何写操作放到别的路径下，否则会连带被放行。
 */
@Tag(name = "用户端-公开浏览")
@RestController
@RequestMapping("/client/catalog")
@RequiredArgsConstructor
public class CatalogController {

    private final DepartmentService departmentService;
    private final DoctorService doctorService;
    private final DoctorScheduleService scheduleService;
    private final DoctorReviewService reviewService;
    private final NoticeService noticeService;

    @Operation(summary = "首页聚合：科室导航 + 推荐医生 + 最新公告")
    @GetMapping("/home")
    public Result<HomeVo> home() {
        HomeVo vo = new HomeVo();
        vo.setDepartments(departmentService.listEnabled());
        vo.setDoctors(doctorService.listTopVisible(6));
        vo.setNotices(noticeService.listLatest(5));
        return Result.ok(vo);
    }

    @Operation(summary = "科室列表")
    @GetMapping("/departments")
    public Result<List<Department>> departments() {
        return Result.ok(departmentService.listEnabled());
    }

    @Operation(summary = "医生列表（按科室/关键词筛选、排序、分页）")
    @GetMapping("/doctors")
    public Result<PageResult<DoctorVo>> doctors(DoctorQuery query) {
        return Result.ok(doctorService.pageVo(query, true));
    }

    @Operation(summary = "医生详情")
    @GetMapping("/doctors/{id}")
    public Result<DoctorVo> doctorDetail(@PathVariable Long id) {
        return Result.ok(doctorService.detail(id));
    }

    @Operation(summary = "医生可约号源。from 默认今天，days 默认 7 天、最多 30 天")
    @GetMapping("/doctors/{id}/schedules")
    public Result<List<ScheduleVo>> doctorSchedules(
            @PathVariable Long id,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) Integer days) {
        return Result.ok(scheduleService.listBookable(id, from, days));
    }

    @Operation(summary = "医生收到的评价")
    @GetMapping("/doctors/{id}/reviews")
    public Result<PageResult<ReviewVo>> doctorReviews(@PathVariable Long id, PageQuery query) {
        return Result.ok(reviewService.pageForDoctor(id, query));
    }

    @Operation(summary = "公告/科普列表。type: 1 公告 2 活动 3 养宠科普")
    @GetMapping("/notices")
    public Result<PageResult<Notice>> notices(PageQuery query,
                                             @RequestParam(required = false) Integer type,
                                             @RequestParam(required = false) String keyword) {
        return Result.ok(noticeService.pagePublished(query, type, keyword));
    }

    @Operation(summary = "公告/科普详情（累加阅读量）")
    @GetMapping("/notices/{id}")
    public Result<Notice> noticeDetail(@PathVariable Long id) {
        return Result.ok(noticeService.readDetail(id));
    }
}
