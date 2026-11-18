package com.yuzhua.controller.admin;

import com.yuzhua.common.BizException;
import com.yuzhua.common.PageResult;
import com.yuzhua.common.Result;
import com.yuzhua.dto.MedicalRecordForm;
import com.yuzhua.dto.RecordQuery;
import com.yuzhua.entity.MedicalRecord;
import com.yuzhua.security.LoginUser;
import com.yuzhua.security.RequireRole;
import com.yuzhua.service.MedicalRecordService;
import com.yuzhua.vo.MedicalRecordVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 后台病历：医生在接诊工作台书写，管理员只读查阅全院的病历（R4）。
 * 读接口不给角色注解（管理员要能查），写接口挂 @RequireRole(DOCTOR)，
 * 服务层再校一次"必须是医生账号 + 责任医生本人"，两层不能只留一层。
 *
 * 写病历以 appointmentId 为准而不是 recordId——医生面对的永远是"这张单"，
 * 是否存在由服务端判断，存在就当作复诊修订处理。
 */
@Tag(name = "管理后台-病历处方")
@RestController
@RequestMapping("/admin/record")
@RequiredArgsConstructor
public class AdminRecordController {

    private final MedicalRecordService recordService;

    @Operation(summary = "病历分页（医生账号自动限定为本人）")
    @GetMapping("/page")
    public Result<PageResult<MedicalRecordVo>> page(RecordQuery query) {
        return Result.ok(recordService.pageForStaff(query));
    }

    @Operation(summary = "某张预约单上的病历，未写则为空")
    @GetMapping("/appointment/{appointmentId}")
    public Result<MedicalRecord> ofAppointment(@PathVariable Long appointmentId) {
        return Result.ok(recordService.ofAppointmentForStaff(appointmentId));
    }

    @Operation(summary = "病历详情")
    @GetMapping("/{id}")
    public Result<MedicalRecordVo> detail(@PathVariable Long id) {
        return Result.ok(recordService.detail(id));
    }

    @Operation(summary = "书写 / 修订病历（诊断结论必填，仅医生账号，R4）")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    @PostMapping("/appointment/{appointmentId}")
    public Result<MedicalRecord> save(@PathVariable Long appointmentId, @RequestBody MedicalRecordForm req) {
        return Result.ok("病历已保存", recordService.saveOrUpdateForAppointment(appointmentId, req));
    }

    /**
     * 病历删除对后台两类账号一律关闭（R4 的只读口径）。
     *
     * 原来这里写着"仅管理员"，等于给管理员留了一条能把整份诊疗记录抹掉的后门——
     * 与"管理员只读查阅病历"直接冲突，删掉后患者端也就看不到这份病历了。
     * 保留路由而不是删掉：让它返回明确的 403，比让调用方拿到 404（与"病历不存在"同形）更好诊断。
     * 写错的更正走修订覆盖，不给物理删除。
     */
    @Operation(summary = "删除病历（已关闭：后台不得删除诊疗记录）")
    @DeleteMapping("/{id}")
    public Result<Void> remove(@PathVariable Long id) {
        throw BizException.forbidden("病历是诊疗记录，后台不提供删除；需要更正由医生在原单上修订");
    }
}
