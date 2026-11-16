package com.petclinic.controller.admin;

import com.petclinic.common.Result;
import com.petclinic.service.StatsService;
import com.petclinic.vo.DashboardVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 后台看板。管理员拿到全院口径，医生账号拿到自己的口径，
 * 同一个接口靠登录态区分，不做两套 URL。
 */
@Tag(name = "管理后台-数据统计")
@RestController
@RequestMapping("/admin/stats")
@RequiredArgsConstructor
public class StatsController {

    private final StatsService statsService;

    @Operation(summary = "看板汇总：数字卡片 + ECharts 图表数据")
    @GetMapping("/dashboard")
    public Result<DashboardVo> dashboard(@RequestParam(required = false) Integer days) {
        return Result.ok(statsService.dashboard(days));
    }
}
